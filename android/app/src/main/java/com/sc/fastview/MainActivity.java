package com.sc.fastview;

import android.Manifest;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Grants the WebView's microphone permission (getUserMedia / MediaRecorder)
 * directly when the app already has RECORD_AUDIO, instead of going through
 * Capacitor's permission-launcher flow, which was denying the request even
 * after the user had granted the permission in Settings. Everything else
 * (file chooser for the image/audio pickers, non-audio permissions, dialogs)
 * is delegated to Capacitor's own WebChromeClient untouched.
 */
public class MainActivity extends BridgeActivity {
    private static final int REQ_RECORD_AUDIO = 1001;
    private PermissionRequest pendingAudioRequest;
    private WebChromeClient capacitorClient;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        capacitorClient = webView.getWebChromeClient();
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean wantsAudio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        wantsAudio = true;
                        break;
                    }
                }
                if (!wantsAudio) {
                    if (capacitorClient != null) {
                        capacitorClient.onPermissionRequest(request);
                    } else {
                        request.deny();
                    }
                    return;
                }
                // Audio capture: grant right away if RECORD_AUDIO is already
                // granted; otherwise ask the user and grant the pending
                // WebView request once they allow it.
                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                } else {
                    pendingAudioRequest = request;
                    ActivityCompat.requestPermissions(MainActivity.this,
                            new String[] { Manifest.permission.RECORD_AUDIO }, REQ_RECORD_AUDIO);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (capacitorClient != null) {
                    return capacitorClient.onShowFileChooser(view, filePathCallback, fileChooserParams);
                }
                return super.onShowFileChooser(view, filePathCallback, fileChooserParams);
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_RECORD_AUDIO && pendingAudioRequest != null) {
            PermissionRequest request = pendingAudioRequest;
            pendingAudioRequest = null;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            } else {
                request.deny();
            }
        }
    }
}
