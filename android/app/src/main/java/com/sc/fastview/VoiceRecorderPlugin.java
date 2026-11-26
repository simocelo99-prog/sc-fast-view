package com.sc.fastview;

import android.Manifest;
import android.media.MediaRecorder;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

/**
 * Records voice notes with Android's native MediaRecorder (AAC in MP4),
 * completely bypassing the WebView's getUserMedia path, which fails with
 * NotReadableError on this user's phone even though the mic permission is
 * granted. Registered from MainActivity; called from the web app through
 * Capacitor.registerPlugin('VoiceRecorder').
 */
@CapacitorPlugin(
    name = "VoiceRecorder",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "recordAudio")
    }
)
public class VoiceRecorderPlugin extends Plugin {
    private MediaRecorder recorder;
    private File outputFile;
    private long startTimeMs;

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("recordAudio") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        requestPermissionForAlias("recordAudio", call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("recordAudio") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void startRecording(PluginCall call) {
        if (recorder != null) {
            call.reject("already recording");
            return;
        }
        if (getPermissionState("recordAudio") != PermissionState.GRANTED) {
            call.reject("permission not granted");
            return;
        }
        try {
            outputFile = new File(getContext().getCacheDir(), "voice-note-" + System.currentTimeMillis() + ".m4a");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                recorder = new MediaRecorder(getContext());
            } else {
                recorder = new MediaRecorder();
            }
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(64000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(outputFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            startTimeMs = System.currentTimeMillis();
            call.resolve();
        } catch (IOException | IllegalStateException e) {
            releaseRecorder();
            call.reject("could not start recording: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        if (recorder == null) {
            call.reject("not recording");
            return;
        }
        try {
            recorder.stop();
        } catch (RuntimeException e) {
            // stop() throws if nothing was recorded yet (tap-stop too fast)
            releaseRecorder();
            if (outputFile != null) outputFile.delete();
            call.reject("recording too short");
            return;
        }
        releaseRecorder();
        try {
            byte[] bytes = readFile(outputFile);
            String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            JSObject ret = new JSObject();
            ret.put("recordDataBase64", base64);
            ret.put("mimeType", "audio/mp4");
            ret.put("msDuration", System.currentTimeMillis() - startTimeMs);
            call.resolve(ret);
            outputFile.delete();
        } catch (IOException e) {
            call.reject("could not read recording");
        }
    }

    @PluginMethod
    public void cancelRecording(PluginCall call) {
        releaseRecorder();
        if (outputFile != null) outputFile.delete();
        call.resolve();
    }

    private void releaseRecorder() {
        if (recorder != null) {
            try {
                recorder.release();
            } catch (Exception ignored) {
                // ignore
            }
            recorder = null;
        }
    }

    private static byte[] readFile(File file) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        FileInputStream in = new FileInputStream(file);
        try {
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            in.close();
        }
        return out.toByteArray();
    }
}
