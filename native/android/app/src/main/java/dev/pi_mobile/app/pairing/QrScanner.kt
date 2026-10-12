package dev.pi_mobile.app.pairing

import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import dev.pi_mobile.app.R
import dev.pi_mobile.app.core.PairingLink
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/** How a scan for the web's "Add a computer" ended (BRIDGE.md `scan`); the shell turns it into the reply. */
sealed interface ScanOutcome {
    /** A code that parses as a [PairingLink], as scanned. */
    data class Link(val link: String) : ScanOutcome

    /** Closed, back, or "Paste link instead": the web's silent `cancelled`. */
    data object Cancelled : ScanOutcome

    /** A sentence to show as is (no camera, permission off, camera busy). */
    data class Unavailable(val message: String) : ScanOutcome
}

/**
 * The scanner as a sheet over the web view, for the bridge's `scan` message (ScanCenter.swift). Asks for
 * the camera first; a refusal ends the scan with a sentence instead of a dead viewfinder. Exactly one
 * [onResult] per sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScannerSheet(onResult: (ScanOutcome) -> Unit) {
    val permission = rememberCameraPermission()
    val unsupported = stringResource(R.string.scan_unsupported)
    val denied = stringResource(R.string.scan_denied)
    var finished by remember { mutableStateOf(false) }
    val finish: (ScanOutcome) -> Unit = { if (!finished) { finished = true; onResult(it) } }
    when {
        !permission.hasCamera -> LaunchedEffect(Unit) { finish(ScanOutcome.Unavailable(unsupported)) }
        permission.access != CameraAccess.GRANTED -> LaunchedEffect(Unit) {
            permission.request { ok -> if (!ok) finish(ScanOutcome.Unavailable(denied)) }
        }
        !finished -> ModalBottomSheet(
            onDismissRequest = { finish(ScanOutcome.Cancelled) },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = Color.Black,
            dragHandle = null,
        ) {
            ScannerScreen(
                onCode = { finish(ScanOutcome.Link(it)) },
                onPaste = { finish(ScanOutcome.Cancelled) },
                onClose = { finish(ScanOutcome.Cancelled) },
            )
        }
    }
}

private enum class ScanHint { POINT, NOT_PI, UNAVAILABLE }

/**
 * The viewfinder (ScannerView.swift): the camera, a frame, one line saying what is happening, and
 * "Paste link instead" (the primary action once the camera can't help). Dark in both themes, like any
 * camera. Only codes that parse as a [PairingLink] reach [onCode], once; others change the hint.
 *
 * @param camera the preview and decoder; tests pass a fake that "sees" a payload.
 */
@Composable
fun ScannerScreen(
    onCode: (String) -> Unit,
    onPaste: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    camera: @Composable (onPayload: (String) -> Unit, onUnavailable: () -> Unit) -> Unit = { onPayload, onUnavailable ->
        QrCamera(onPayload, onUnavailable, Modifier.fillMaxSize())
    },
) {
    var hint by remember { mutableStateOf(ScanHint.POINT) }
    var done by remember { mutableStateOf(false) }
    val unavailable = hint == ScanHint.UNAVAILABLE
    val cameraLabel = stringResource(R.string.scan_camera)
    Box(modifier.fillMaxSize().background(Color.Black)) {
        if (!unavailable) {
            Box(Modifier.fillMaxSize().semantics { contentDescription = cameraLabel }) {
                camera(
                    { payload ->
                        if (!done) {
                            if (PairingLink.parse(payload) != null) {
                                done = true
                                onCode(payload)
                            } else {
                                hint = ScanHint.NOT_PI
                            }
                        }
                    },
                    { hint = ScanHint.UNAVAILABLE },
                )
            }
        }
        Box(
            Modifier
                .align(Alignment.Center)
                .size(250.dp)
                .border(3.dp, Color.White.copy(alpha = if (hint == ScanHint.NOT_PI) 0.6f else 0.9f), RoundedCornerShape(28.dp))
                .clearAndSetSemantics {},
        )
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                IconButton(onClick = onClose, modifier = Modifier.size(48.dp).background(Color.White.copy(alpha = 0.18f), CircleShape)) {
                    Icon(Icons.Rounded.Close, contentDescription = stringResource(R.string.close), tint = Color.White)
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                stringResource(
                    when (hint) {
                        ScanHint.POINT -> R.string.scan_hint
                        ScanHint.NOT_PI -> R.string.scan_not_pi
                        ScanHint.UNAVAILABLE -> R.string.scan_unavailable
                    },
                ),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                color = Color.White,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .widthIn(max = 360.dp)
                    .background(Color(0xFF2A2C31).copy(alpha = 0.85f), RoundedCornerShape(50))
                    .padding(horizontal = 16.dp, vertical = 10.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
            Spacer(Modifier.size(12.dp))
            Button(
                onClick = onPaste,
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (unavailable) Color.White else Color.White.copy(alpha = 0.18f),
                    contentColor = if (unavailable) Color.Black else Color.White,
                ),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(
                    stringResource(R.string.pairing_paste_instead),
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = if (unavailable) FontWeight.SemiBold else FontWeight.Medium),
                )
            }
        }
    }
}

/**
 * The back camera through CameraX, read by ML Kit's bundled QR model (no Play services needed;
 * plans/native-android.md A12). Unbinds when it leaves the composition, so the camera is never left on.
 * [onUnavailable] fires when the camera can't start or is taken away (another app, policy).
 */
@Composable
fun QrCamera(onPayload: (String) -> Unit, onUnavailable: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val payload by rememberUpdatedState(onPayload)
    val unavailable by rememberUpdatedState(onUnavailable)
    val view = remember(context) { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(owner) {
        val main = ContextCompat.getMainExecutor(context)
        val worker = Executors.newSingleThreadExecutor()
        val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
        val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(worker) { proxy -> decode(proxy, scanner, main) { payload(it) } }
        val future = ProcessCameraProvider.getInstance(context)
        var disposed = false
        future.addListener({
            if (disposed) return@addListener
            try {
                val camera = future.get().bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                camera.cameraInfo.cameraState.observe(owner) { state ->
                    val code = state.error?.code
                    if (state.error?.type == CameraState.ErrorType.CRITICAL || code == CameraState.ERROR_CAMERA_IN_USE ||
                        code == CameraState.ERROR_MAX_CAMERAS_IN_USE || code == CameraState.ERROR_CAMERA_DISABLED
                    ) unavailable()
                }
            } catch (_: Exception) {
                unavailable()
            }
        }, main)
        onDispose {
            disposed = true
            if (future.isDone) runCatching { future.get().unbind(preview, analysis) }
            analysis.clearAnalyzer()
            scanner.close()
            worker.shutdown()
        }
    }
    AndroidView({ view }, modifier)
}

@androidx.annotation.OptIn(ExperimentalGetImage::class)
private fun decode(proxy: ImageProxy, scanner: BarcodeScanner, main: Executor, onPayload: (String) -> Unit) {
    val image = proxy.image ?: return proxy.close()
    scanner.process(InputImage.fromMediaImage(image, proxy.imageInfo.rotationDegrees))
        .addOnSuccessListener(main) { codes -> codes.firstNotNullOfOrNull { it.rawValue }?.let(onPayload) }
        .addOnCompleteListener { proxy.close() }
}
