// Imports run one at a time, in the order they were started (two whisper runs at
// once would each take every core), and a deleted card stops its import.
use std::cell::RefCell;
use std::process::Child;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

pub(crate) const CANCELLED: &str = "cancelled";

struct Line {
  // Waiting or running, in order; the first one runs.
  ids: Vec<String>,
  cancelled: Vec<String>,
  // Permanently deleted jobs: never allowed to re-enter the queue until cleared.
  tombstones: Vec<String>,
  // The running import's current tool (yt-dlp / ffmpeg / whisper-cli).
  child: Option<(String, Arc<Mutex<Child>>)>,
}

static LINE: Mutex<Line> = Mutex::new(Line {
  ids: Vec::new(),
  cancelled: Vec::new(),
  tombstones: Vec::new(),
  child: None,
});
static TURN: Condvar = Condvar::new();

thread_local! {
  // The import this thread is running, so run_streaming can register its child.
  static CURRENT: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn line() -> MutexGuard<'static, Line> {
  LINE.lock().unwrap_or_else(PoisonError::into_inner)
}

// Holding it = this import's place in the line; dropping it lets the next one go.
pub(crate) struct Turn(String);

impl Drop for Turn {
  fn drop(&mut self) {
    let mut line = line();
    if let Some(i) = line.ids.iter().position(|x| *x == self.0) {
      line.ids.remove(i);
    }
    line.cancelled.retain(|x| *x != self.0);
    if line.child.as_ref().is_some_and(|(owner, _)| *owner == self.0) {
      line.child = None;
    }
    drop(line);
    CURRENT.with(|c| *c.borrow_mut() = None);
    TURN.notify_all();
  }
}

// Joins the line and blocks until it is this import's turn. `on_wait` runs once
// when someone is ahead (the card shows "queued").
pub(crate) fn wait_turn(id: &str, on_wait: impl FnOnce()) -> Result<Turn, String> {
  let mut line = line();
  if line.tombstones.iter().any(|x| x == id) {
    return Err(CANCELLED.into());
  }
  line.ids.push(id.to_string());
  if line.ids[0] != id {
    drop(line); // the event goes out without holding up cancel / check
    on_wait();
    line = self::line();
  }
  loop {
    if line.cancelled.iter().any(|x| x == id) || line.tombstones.iter().any(|x| x == id) {
      drop(line); // Turn's drop takes the lock
      drop(Turn(id.to_string()));
      return Err(CANCELLED.into());
    }
    if line.ids[0] == id {
      break;
    }
    line = TURN.wait(line).unwrap_or_else(PoisonError::into_inner);
  }
  drop(line);
  CURRENT.with(|c| *c.borrow_mut() = Some(id.to_string()));
  Ok(Turn(id.to_string()))
}

// Between steps: stop here if the card was deleted meanwhile.
pub(crate) fn check() -> Result<(), String> {
  if CURRENT.with(|c| {
    c.borrow().as_ref().is_some_and(|id| {
      let l = line();
      l.cancelled.contains(id) || l.tombstones.contains(id)
    })
  }) {
    return Err(CANCELLED.into());
  }
  Ok(())
}

// run_streaming's child, killable by cancel() while the running import owns it.
// Cancelled already: killed at once. Not on an import thread: nothing happens.
pub(crate) fn watch(child: &Arc<Mutex<Child>>) {
  let Some(id) = CURRENT.with(|c| c.borrow().clone()) else { return };
  let mut line = line();
  let cancelled = line.cancelled.contains(&id);
  line.child = Some((id, child.clone()));
  drop(line);
  if cancelled {
    kill(child);
  }
}

// The tool and anything it started (run_streaming gives it its own process group).
pub(crate) fn kill(child: &Arc<Mutex<Child>>) {
  let mut child = child.lock().unwrap_or_else(PoisonError::into_inner);
  #[cfg(all(unix, not(target_os = "android")))]
  {
    let _ = std::process::Command::new("/bin/kill").args(["-KILL", "--", &format!("-{}", child.id())]).status();
  }
  let _ = child.kill();
}

pub(crate) fn unwatch() {
  let Some(id) = CURRENT.with(|c| c.borrow().clone()) else { return };
  let mut line = line();
  if line.child.as_ref().is_some_and(|(owner, _)| *owner == id) {
    line.child = None;
  }
}

// The card is gone: a waiting import leaves the line, a running one loses its
// current tool and stops at the next check. Unknown ids (already finished) do nothing.
pub(crate) fn cancel(id: &str) {
  let mut line = line();
  if !line.ids.iter().any(|x| x == id) {
    return;
  }
  if !line.cancelled.iter().any(|x| x == id) {
    line.cancelled.push(id.to_string());
  }
  let running = line.child.as_ref().filter(|(owner, _)| owner == id).map(|(_, child)| child.clone());
  drop(line); // never wait on the child's lock while holding the line's
  TURN.notify_all();
  if let Some(child) = running {
    kill(&child);
  }
}

// Permanently cancels a deleted record's job and blocks any late piece/finalize call from resuming it.
pub(crate) fn tombstone(id: &str) {
  {
    let mut l = line();
    if !l.tombstones.iter().any(|x| x == id) {
      l.tombstones.push(id.to_string());
    }
  }
  cancel(id);
}

#[allow(dead_code)]
pub(crate) fn clear_tombstone(id: &str) {
  let mut l = line();
  l.tombstones.retain(|x| x != id);
}

#[allow(dead_code)]
pub(crate) fn is_tombstoned(id: &str) -> bool {
  line().tombstones.iter().any(|x| x == id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc;
  use std::thread;
  use std::time::Duration;

  #[test]
  fn one_at_a_time_in_order_and_cancel_while_waiting() {
    let first = wait_turn("q-a", || panic!("nobody ahead")).unwrap();
    let (tx, rx) = mpsc::channel();
    let waiting = |id: &'static str, tx: mpsc::Sender<String>| {
      thread::spawn(move || {
        let r = wait_turn(id, || tx.send(format!("{id} queued")).unwrap());
        tx.send(format!("{id} {}", if r.is_ok() { "runs" } else { "cancelled" })).unwrap();
      })
    };
    let b = waiting("q-b", tx.clone());
    assert_eq!(rx.recv().unwrap(), "q-b queued");
    let c = waiting("q-c", tx.clone());
    assert_eq!(rx.recv().unwrap(), "q-c queued");
    cancel("q-b");
    assert_eq!(rx.recv().unwrap(), "q-b cancelled");
    assert!(rx.recv_timeout(Duration::from_millis(100)).is_err(), "c must wait for a");
    drop(first);
    assert_eq!(rx.recv().unwrap(), "q-c runs");
    b.join().unwrap();
    c.join().unwrap();
    cancel("q-gone"); // finished or never started: nothing to do
    {
      let line = line();
      assert!(line.ids.is_empty() && line.cancelled.is_empty());
    }
    // One test: the line is shared, a second test running alongside would be "ahead".
    #[cfg(unix)]
    cancel_kills_the_running_tool();
    #[cfg(unix)]
    cancel_stops_run_streaming();
    crate::cloud_pieces::tests::cancel_drops_pieces_in_flight();
    tombstone_blocks_wait_turn_and_clears();
  }

  fn tombstone_blocks_wait_turn_and_clears() {
    let id = "tomb-a";
    assert!(!is_tombstoned(id));
    tombstone(id);
    assert!(is_tombstoned(id));
    let err = wait_turn(id, || panic!("tombstoned job must not queue")).err().unwrap();
    assert_eq!(err, CANCELLED);
    clear_tombstone(id);
    assert!(!is_tombstoned(id));
    let turn = wait_turn(id, || panic!("nobody ahead")).unwrap();
    tombstone(id);
    assert_eq!(check(), Err(CANCELLED.to_string()));
    drop(turn);
    clear_tombstone(id);
    assert!(!is_tombstoned(id));
  }

  // The real path: an import thread's tool, read line by line, stops within moments.
  #[cfg(unix)]
  fn cancel_stops_run_streaming() {
    let started = std::time::Instant::now();
    let worker = thread::spawn(|| {
      let _turn = wait_turn("s-a", || {}).unwrap();
      let mut cmd = std::process::Command::new("sh");
      // A helper (`sleep`) that holds our pipes, like a single-file yt-dlp's child.
      cmd.args(["-c", "echo hi; sleep 30.4321; echo late"]);
      let (code, _) = crate::import::run_streaming(cmd, |_| {}).unwrap();
      (code, check())
    });
    thread::sleep(Duration::from_millis(300));
    cancel("s-a");
    let (code, after) = worker.join().unwrap();
    assert_ne!(code, 0);
    assert_eq!(after, Err(CANCELLED.to_string()));
    assert!(started.elapsed() < Duration::from_secs(5));
    // The helper went too: nothing of ours is left sleeping.
    thread::sleep(Duration::from_millis(100));
    let left = std::process::Command::new("pgrep").args(["-f", "sleep 30.4321"]).output().unwrap();
    assert!(left.stdout.is_empty(), "helper still running");
  }

  #[cfg(unix)]
  fn cancel_kills_the_running_tool() {
    let turn = wait_turn("k-a", || {}).unwrap();
    let child = Arc::new(Mutex::new(std::process::Command::new("sleep").arg("30").spawn().unwrap()));
    watch(&child);
    cancel("k-a");
    let status = child.lock().unwrap().wait().unwrap();
    assert!(!status.success());
    assert_eq!(check(), Err(CANCELLED.to_string()));
    unwatch();
    drop(turn);
    assert_eq!(check(), Ok(()));
  }
}
