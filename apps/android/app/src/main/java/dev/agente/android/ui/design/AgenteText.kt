package dev.agente.android.ui.design

import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow

/** The ladder's rungs, named by what they are for rather than by size. */
enum class TextRole { Greeting, Prose, Base, Small, Caption, Code }

fun AgenteType.style(role: TextRole): TextStyle = when (role) {
    TextRole.Greeting -> greeting
    TextRole.Prose -> prose
    TextRole.Base -> base
    TextRole.Small -> small
    TextRole.Caption -> caption
    TextRole.Code -> code
}

/**
 * The app's only text. `BasicText` plus the ladder: a screen never sets a size,
 * and never reaches for a component library's `Text`, so captions, chrome,
 * prose and code all move together with the system font size.
 */
@Composable
fun AgenteText(
    text: String,
    modifier: Modifier = Modifier,
    role: TextRole = TextRole.Base,
    color: Color = AgenteTheme.colors.foreground,
    weight: FontWeight? = null,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
    textAlign: TextAlign? = null,
    softWrap: Boolean = true
) = AgenteText(AnnotatedString(text), modifier, role, color, weight, maxLines, overflow, textAlign, softWrap)

@Composable
fun AgenteText(
    text: AnnotatedString,
    modifier: Modifier = Modifier,
    role: TextRole = TextRole.Base,
    color: Color = AgenteTheme.colors.foreground,
    weight: FontWeight? = null,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
    textAlign: TextAlign? = null,
    softWrap: Boolean = true
) {
    val base = AgenteTheme.type.style(role)
    BasicText(
        text = text,
        modifier = modifier,
        style = base.copy(
            color = color,
            fontWeight = weight ?: base.fontWeight,
            textAlign = textAlign ?: TextAlign.Unspecified
        ),
        maxLines = maxLines,
        overflow = overflow,
        softWrap = softWrap
    )
}
