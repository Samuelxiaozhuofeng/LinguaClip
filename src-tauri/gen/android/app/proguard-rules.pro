# Keep LinguaClip JS bridge and Media3 PlaybackService intact in release builds.
-keepclassmembers class com.linguaclip.app.LinguaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.linguaclip.app.PlaybackService { *; }
-keep class com.linguaclip.app.MediaProcessingService { *; }
-keep class com.linguaclip.app.MainActivity { *; }
-keep class androidx.media3.** { *; }
