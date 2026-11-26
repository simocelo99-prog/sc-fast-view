package com.sc.fastview;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Reads a DWG/DXF file the user opened with SC Fast View from another app
 * (WhatsApp, Files, ...). The app declares VIEW intent filters for .dwg and
 * .dxf, so Android lists it in the "Open with" chooser. When the user picks
 * it, the web app asks this plugin for the file's bytes (base64) and name,
 * then opens it exactly like a file picked from inside the app. After a
 * successful read the intent's data is cleared, so a later normal launch
 * does not re-open the same file.
 */
@CapacitorPlugin(name = "IntentFile")
public class IntentFilePlugin extends Plugin {
    @PluginMethod
    public void getIntentFile(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.resolve(new JSObject()); return; }
        Intent intent = activity.getIntent();
        Uri uri = (intent == null) ? null : intent.getData();
        if (uri == null) { call.resolve(new JSObject()); return; }
        try {
            byte[] bytes;
            try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
                if (in == null) { call.resolve(new JSObject()); return; }
                bytes = readAll(in);
            }
            String name = displayName(activity, uri);
            // Clear the intent data so the file is not re-opened on the
            // next normal launch.
            intent.setData(null);
            JSObject ret = new JSObject();
            ret.put("name", name);
            ret.put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (IOException | SecurityException e) {
            call.reject("could not read file: " + e.getMessage());
        }
    }

    private static String displayName(Activity activity, Uri uri) {
        // Prefer the display name from the content provider (WhatsApp, Files).
        try (Cursor c = activity.getContentResolver().query(uri,
                new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) { /* fall through to the URI path */ }
        String path = uri.getLastPathSegment();
        if (path != null && !path.isEmpty()) return path;
        return "file.dwg";
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
