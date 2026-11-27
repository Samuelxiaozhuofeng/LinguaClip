// Phone: do stuck lines (wrong / peeked / hinted) go into review on their own? (docs/android.md「手机学习闭环」)
// Shares practice_config.autoAddReview with the desktop, but on the phone an unset value means ON.
import { getPracticeConfig, savePracticeConfig } from '../utils/storage';

export const autoAddOn = (): boolean => getPracticeConfig().autoAddReview ?? true;
export const setAutoAdd = (on: boolean) => savePracticeConfig({ ...getPracticeConfig(), autoAddReview: on });
