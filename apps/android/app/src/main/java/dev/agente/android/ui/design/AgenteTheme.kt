package dev.agente.android.ui.design

import android.animation.ValueAnimator
import android.content.Context
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import dev.agente.android.R
import dev.agente.android.data.ThemeChoice

/** Inter for the interface and prose, IBM Plex Mono for code, diffs and the
 *  terminal — the same pair the desktop bundles, both OFL. */
private val Inter = FontFamily(Font(R.font.inter))
private val PlexMono = FontFamily(
    Font(R.font.ibm_plex_mono, FontWeight.Normal),
    Font(R.font.ibm_plex_mono_medium, FontWeight.Medium)
)

/** The one type ladder (`--text-*`), as text styles. Sizes are `sp`, so the
 *  system font scale moves captions, chrome, prose and code together. */
data class AgenteType(
    /** The landing's one display size: the only rung above the ladder's prose
     *  step, and the only place the phone raises its voice. */
    val greeting: TextStyle,
    val prose: TextStyle,
    val base: TextStyle,
    val small: TextStyle,
    val caption: TextStyle,
    val code: TextStyle
)

private fun ladder(
    size: androidx.compose.ui.unit.TextUnit,
    family: FontFamily,
    weight: FontWeight = FontWeight.Normal,
    leading: Float = AgenteTokens.Type.leading
) = TextStyle(
    fontFamily = family,
    fontSize = size,
    lineHeight = size * leading,
    fontWeight = weight
)

/** Every transition picks a step from the ladder; `reduceMotion` snaps instead
 *  of starting one, so nothing moves for a reader who asked for stillness. */
class AgenteMotion(val reduceMotion: Boolean) {
    fun <T> spec(durationMs: Int, entering: Boolean = true): FiniteAnimationSpec<T> =
        if (reduceMotion) snap() else tween(durationMs, easing = if (entering) enter else standard)

    val enter: Easing = CubicBezierEasing(
        AgenteTokens.Curves.enter[0], AgenteTokens.Curves.enter[1],
        AgenteTokens.Curves.enter[2], AgenteTokens.Curves.enter[3]
    )
    val standard: Easing = CubicBezierEasing(
        AgenteTokens.Curves.standard[0], AgenteTokens.Curves.standard[1],
        AgenteTokens.Curves.standard[2], AgenteTokens.Curves.standard[3]
    )
}

/**
 * The one scrim, shared by the drawer, the sheets and the search modal. Black at
 * 40% in both themes rather than a tint of the canvas: a panel plane (card,
 * panel) has to read *above* the receded page, and a canvas-tinted veil lands
 * within a shade of the plane it is supposed to sit under.
 */
val AgenteScrim: Color = Color.Black.copy(alpha = 0.4f)

private val LocalAgenteColors = staticCompositionLocalOf<AgentePalette> { error("AgenteTheme is missing") }
private val LocalAgenteDark = staticCompositionLocalOf { true }
private val LocalAgenteType = staticCompositionLocalOf<AgenteType> { error("AgenteTheme is missing") }
private val LocalAgenteMotion = staticCompositionLocalOf<AgenteMotion> { error("AgenteTheme is missing") }

object AgenteTheme {
    val colors: AgentePalette
        @Composable @ReadOnlyComposable get() = LocalAgenteColors.current

    /** Which side of the pair is in effect: a starter's hue needs it to pick its
     *  own lightness, the way the desktop's two rules do. */
    val isDark: Boolean
        @Composable @ReadOnlyComposable get() = LocalAgenteDark.current

    val type: AgenteType
        @Composable @ReadOnlyComposable get() = LocalAgenteType.current

    val motion: AgenteMotion
        @Composable @ReadOnlyComposable get() = LocalAgenteMotion.current
}

// The platform keeps this key out of the SDK (`Settings.Secure` has no public
// constant for it), so the name is spelled out: it is the switch behind
// Settings → Accessibility → High contrast text.
private const val HIGH_TEXT_CONTRAST = "high_text_contrast_enabled"

private fun highContrast(context: Context): Boolean =
    Settings.Secure.getInt(context.contentResolver, HIGH_TEXT_CONTRAST, 0) == 1

/**
 * The app's only theme. It replaces `MaterialTheme` rather than configuring it:
 * the phone draws the desktop's planes and ladder directly, and no Material
 * component is allowed in a screen (see the boundary test).
 */
@Composable
fun AgenteTheme(choice: ThemeChoice, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val dark = when (choice) {
        ThemeChoice.Auto -> isSystemInDarkTheme()
        ThemeChoice.Light -> false
        ThemeChoice.Dark -> true
    }
    val colors = remember(dark, context) {
        val base = if (dark) AgenteTokens.darkPalette else AgenteTokens.lightPalette
        if (!highContrast(context)) base else {
            val raised = if (dark) AgenteTokens.darkContrast else AgenteTokens.lightContrast
            base.copy(
                mutedForeground = raised.mutedForeground,
                secondary = raised.secondary,
                line = raised.line,
                lineSubtle = raised.lineSubtle,
                ring = raised.ring
            )
        }
    }
    val type = remember {
        AgenteType(
            greeting = ladder(AgenteTokens.Type.textProse * 1.6f, Inter, FontWeight.Medium, leading = 1.3f),
            prose = ladder(AgenteTokens.Type.textProse, Inter),
            base = ladder(AgenteTokens.Type.textBase, Inter),
            small = ladder(AgenteTokens.Type.textSm, Inter),
            caption = ladder(AgenteTokens.Type.textXs, Inter),
            code = ladder(AgenteTokens.Type.textCode, PlexMono)
        )
    }
    val motion = remember { AgenteMotion(reduceMotion = !ValueAnimator.areAnimatorsEnabled()) }

    val view = LocalView.current
    val activity = LocalActivity.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = activity?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    CompositionLocalProvider(
        LocalAgenteColors provides colors,
        LocalAgenteDark provides dark,
        LocalAgenteType provides type,
        LocalAgenteMotion provides motion,
        content = content
    )
}
