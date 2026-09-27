/**
 * Video History and Progress Management
 */

import { VideoRecord, PracticeProgress, LearningMode, BlurPlaybackMode } from '../types';
import * as FileSystemAccess from './fileSystemAccess';

const STORAGE_KEY_PROGRESS = 'linguaclip_video_progress';

/**
 * Create a new video record
 */
export interface CreateVideoRecordOptions {
  videoPath?: string;
  learningMode?: LearningMode;
  blurPlaybackMode?: BlurPlaybackMode;
}

export const createVideoRecord = async (
  videoName: string,
  subtitleFile: File,
  subtitleText: string,
  totalSubtitles: number,
  options: CreateVideoRecordOptions = {}
): Promise<VideoRecord> => {
  const {
    videoPath,
    learningMode = LearningMode.DICTATION,
    blurPlaybackMode = BlurPlaybackMode.SENTENCE_BY_SENTENCE,
  } = options;
  const id = crypto.randomUUID();
  
  const record: VideoRecord = {
    id,
    displayName: videoName,
    videoFileName: videoName,
    subtitleFileName: subtitleFile.name,
    subtitleText,
    currentSubtitleIndex: 0,
    currentSectionIndex: 0,
    totalSubtitles,
    completionRate: 0,
    dateAdded: Date.now(),
    lastPracticed: Date.now(),
    totalPracticeTime: 0,
    learningMode,
    blurPlaybackMode,
    videoPath,
  };

  await FileSystemAccess.saveVideoToDB(record);

  return record;
};

/**
 * Get all video records
 */
export const getAllVideoRecords = async (): Promise<VideoRecord[]> => {
  try {
    const records = await FileSystemAccess.getAllVideosFromDB();
    // Sort by last practiced (most recent first)
    return records.sort((a, b) => b.lastPracticed - a.lastPracticed);
  } catch (error) {
    console.error('Failed to get video records:', error);
    return [];
  }
};

/**
 * Get a single video record by ID
 */
export const getVideoRecord = async (id: string): Promise<VideoRecord | null> => {
  try {
    return await FileSystemAccess.getVideoFromDB(id);
  } catch (error) {
    console.error('Failed to get video record:', error);
    return null;
  }
};

/**
 * Update video record
 */
export const updateVideoRecord = async (record: VideoRecord): Promise<void> => {
  try {
    await FileSystemAccess.saveVideoToDB(record);
  } catch (error) {
    console.error('Failed to update video record:', error);
    throw error;
  }
};

/**
 * Delete video record
 */
export const deleteVideoRecord = async (id: string): Promise<void> => {
  try {
    await FileSystemAccess.deleteVideoFromDB(id);
  } catch (error) {
    console.error('Failed to delete video record:', error);
    throw error;
  }
};

/**
 * Update practice progress
 */
export const updateProgress = async (
  videoId: string,
  currentSubtitleIndex: number,
  currentSectionIndex: number,
  absoluteIndex: number = currentSubtitleIndex // index across the whole video (sections restart at 0)
): Promise<void> => {
  try {
    const record = await getVideoRecord(videoId);
    if (!record) return;

    // Update progress
    record.currentSubtitleIndex = currentSubtitleIndex;
    record.currentSectionIndex = currentSectionIndex;
    record.lastPracticed = Date.now();
    
    // Calculate completion rate
    if (record.totalSubtitles > 0) {
      record.completionRate = Math.min(100, Math.round((absoluteIndex / record.totalSubtitles) * 100));
    }

    await updateVideoRecord(record);
  } catch (error) {
    console.error('Failed to update progress:', error);
  }
};

/**
 * Create subtitle file from stored text
 */
export const getSubtitleFileFromRecord = (record: VideoRecord): File => {
  const blob = new Blob([record.subtitleText], { type: 'text/plain' });
  return new File([blob], record.subtitleFileName, { type: 'text/plain' });
};

/**
 * Update total practice time
 */
export const updatePracticeTime = async (videoId: string, additionalSeconds: number): Promise<void> => {
  try {
    const record = await getVideoRecord(videoId);
    if (!record) return;

    record.totalPracticeTime += additionalSeconds;
    await updateVideoRecord(record);
  } catch (error) {
    console.error('Failed to update practice time:', error);
  }
};

/**
 * Format practice time for display
 */
export const formatPracticeTime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

/**
 * Format last practiced time for display
 */
export const formatLastPracticed = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  
  return new Date(timestamp).toLocaleDateString();
};

/**
 * Remember the mode the user picked for this video (last-used wins).
 */
// Re-reads the record before writing so a caller holding a stale copy can't roll back progress.
export const patchVideoRecord = async (
  videoId: string,
  patch: Partial<Pick<VideoRecord, 'learningMode' | 'blurPlaybackMode' | 'videoPath' | 'lastPracticed' | 'lang'>>
): Promise<void> => {
  try {
    const record = await getVideoRecord(videoId);
    if (!record) return;
    await updateVideoRecord({ ...record, ...patch });
  } catch (error) {
    console.error('Failed to patch video record:', error);
  }
};
