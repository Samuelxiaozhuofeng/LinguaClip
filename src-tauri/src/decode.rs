// A video's audio track → 16 kHz mono 16-bit WAV for whisper, in pure Rust.
// Used where macOS's afconvert is not around (Windows), so strangers need no
// ffmpeg. Streams packet by packet: the video is never read into memory.
#![cfg_attr(target_os = "macos", allow(dead_code))]

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const OUT_RATE: u32 = 16_000;

pub fn to_wav(video: &Path, wav: &Path) -> Result<(), String> {
  let file = File::open(video).map_err(|e| e.to_string())?;
  let stream = MediaSourceStream::new(Box::new(file), Default::default());
  let mut hint = Hint::new();
  if let Some(ext) = video.extension().and_then(|e| e.to_str()) {
    hint.with_extension(ext);
  }
  let probed = symphonia::default::get_probe()
    .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
    .map_err(|e| e.to_string())?;
  let mut format = probed.format;
  let track = format
    .tracks()
    .iter()
    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some())
    .ok_or_else(|| "no audio track".to_string())?;
  let track_id = track.id;
  let rate = track.codec_params.sample_rate.unwrap_or(OUT_RATE);
  let mut decoder = symphonia::default::get_codecs()
    .make(&track.codec_params, &DecoderOptions::default())
    .map_err(|e| e.to_string())?;

  let mut out = WavWriter::create(wav)?;
  let mut down = Downsampler::new(rate);
  let mut buf: Option<SampleBuffer<f32>> = None;
  loop {
    crate::import_queue::check()?; // the card was deleted
    let packet = match format.next_packet() {
      Ok(p) => p,
      Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
      Err(e) => return Err(e.to_string()),
    };
    if packet.track_id() != track_id {
      continue;
    }
    let decoded = match decoder.decode(&packet) {
      Ok(d) => d,
      Err(Error::DecodeError(_)) => continue, // one damaged frame: skip it
      Err(e) => return Err(e.to_string()),
    };
    let spec = *decoded.spec();
    let channels = spec.channels.count().max(1);
    if buf.as_ref().map_or(true, |b| b.capacity() < decoded.capacity() * channels) {
      buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
    }
    let Some(samples) = buf.as_mut() else { continue };
    samples.copy_interleaved_ref(decoded);
    for frame in samples.samples().chunks(channels) {
      let mono = frame.iter().sum::<f32>() / channels as f32;
      down.push(mono, &mut |s| out.write(s))?;
    }
  }
  down.finish(&mut |s| out.write(s))?;
  // Every packet failed to decode: say so, so ffmpeg (if any) gets a turn
  // instead of whisper getting silence.
  if out.samples == 0 {
    return Err("no audio decoded".into());
  }
  out.finish()
}

// Averages the input samples that fall into each output sample's slot: a box
// filter, enough to keep aliasing out of speech for whisper.
// ponytail: box filter, not a windowed-sinc resampler; swap in rubato if
// transcripts from Windows come out noticeably worse than afconvert's.
struct Downsampler {
  ratio: f64,
  index: u64,
  slot: u64,
  sum: f32,
  n: u32,
  last: f32,
}

impl Downsampler {
  fn new(in_rate: u32) -> Self {
    Self { ratio: in_rate as f64 / OUT_RATE as f64, index: 0, slot: 0, sum: 0.0, n: 0, last: 0.0 }
  }

  fn push(&mut self, x: f32, emit: &mut impl FnMut(f32) -> Result<(), String>) -> Result<(), String> {
    let slot = (self.index as f64 / self.ratio) as u64;
    // Slots skipped over (input slower than 16 kHz) repeat the last value.
    while slot > self.slot {
      if self.n > 0 {
        self.last = self.sum / self.n as f32;
      }
      emit(self.last)?;
      self.slot += 1;
      self.sum = 0.0;
      self.n = 0;
    }
    self.sum += x;
    self.n += 1;
    self.index += 1;
    Ok(())
  }

  fn finish(&mut self, emit: &mut impl FnMut(f32) -> Result<(), String>) -> Result<(), String> {
    if self.n > 0 {
      emit(self.sum / self.n as f32)?;
    }
    Ok(())
  }
}

struct WavWriter {
  file: BufWriter<File>,
  samples: u32,
}

impl WavWriter {
  fn create(path: &Path) -> Result<Self, String> {
    let mut file = BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
    // Sizes are filled in by finish(); the rest is fixed: PCM, 1 channel, 16-bit.
    let mut head = Vec::with_capacity(44);
    head.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
    head.extend_from_slice(&16u32.to_le_bytes());
    head.extend_from_slice(&1u16.to_le_bytes());
    head.extend_from_slice(&1u16.to_le_bytes());
    head.extend_from_slice(&OUT_RATE.to_le_bytes());
    head.extend_from_slice(&(OUT_RATE * 2).to_le_bytes());
    head.extend_from_slice(&2u16.to_le_bytes());
    head.extend_from_slice(&16u16.to_le_bytes());
    head.extend_from_slice(b"data\0\0\0\0");
    file.write_all(&head).map_err(|e| e.to_string())?;
    Ok(Self { file, samples: 0 })
  }

  fn write(&mut self, x: f32) -> Result<(), String> {
    let v = (x.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
    self.samples += 1;
    self.file.write_all(&v.to_le_bytes()).map_err(|e| e.to_string())
  }

  fn finish(mut self) -> Result<(), String> {
    let data = self.samples * 2;
    let io = |e: std::io::Error| e.to_string();
    self.file.seek(SeekFrom::Start(4)).map_err(io)?;
    self.file.write_all(&(36 + data).to_le_bytes()).map_err(io)?;
    self.file.seek(SeekFrom::Start(40)).map_err(io)?;
    self.file.write_all(&data.to_le_bytes()).map_err(io)?;
    self.file.flush().map_err(io)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // tests/fixtures/tone*.{mp4,mov,m4v}: 3 s of a 440 Hz tone (tone.mp4/.mov: stereo AAC at 44.1 kHz)
  // (made with ffmpeg's sine source). Checks length, format and that it is not silent.
  fn check(name: &str) {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let wav = std::env::temp_dir().join(format!("lc-decode-{}.wav", uuid::Uuid::new_v4()));
    to_wav(&src, &wav).unwrap();
    let bytes = std::fs::read(&wav).unwrap();
    std::fs::remove_file(&wav).unwrap();
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 16_000);
    let data = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
    assert_eq!(bytes.len(), 44 + data);
    let secs = data as f64 / 2.0 / 16_000.0;
    assert!((secs - 3.0).abs() < 0.1, "{name}: {secs}s");
    let pcm: Vec<i16> = bytes[44..].chunks(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    let rms = (pcm.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / pcm.len() as f64).sqrt();
    assert!(rms > 1000.0, "{name}: rms {rms}");
  }

  #[test]
  fn decodes_mp4() {
    check("tone.mp4");
  }

  #[test]
  fn decodes_mov() {
    check("tone.mov");
  }

  // Same tone with the other audio codecs mp4/mov carry: MP3, 16-bit PCM
  // (camera .mov, mono 22.05 kHz), ALAC. Opus and AC-3 have no decoder here.
  #[test]
  fn decodes_other_codecs() {
    for name in ["tone-mp3.mp4", "tone-pcm.mov", "tone-alac.m4v"] {
      check(name);
    }
  }

  #[test]
  fn downsampler_keeps_length() {
    for rate in [8_000u32, 16_000, 44_100, 48_000] {
      let mut d = Downsampler::new(rate);
      let mut n = 0usize;
      for _ in 0..rate {
        d.push(0.5, &mut |_| {
          n += 1;
          Ok(())
        })
        .unwrap();
      }
      d.finish(&mut |_| {
        n += 1;
        Ok(())
      })
      .unwrap();
      assert!((n as i64 - 16_000).abs() <= 2, "{rate} Hz -> {n} samples");
    }
  }
}
