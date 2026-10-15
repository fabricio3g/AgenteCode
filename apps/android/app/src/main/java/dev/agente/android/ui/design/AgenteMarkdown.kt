package dev.agente.android.ui.design

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.agente.android.R
import kotlinx.coroutines.delay

/**
 * Assistant prose, rendered the way the desktop renders it: headings, bold,
 * italic, inline code, lists, task lists, quotes, rules, tables and fenced code.
 * The phone has no second markdown dialect — the same constructs, in the same
 * order, with tables and code scrolling sideways instead of wrapping.
 */
@Composable
fun AgenteMarkdown(text: String, modifier: Modifier = Modifier) {
    val colors = AgenteTheme.colors
    val blocks = remember(text) { parseMarkdown(text) }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Heading -> AgenteText(
                    text = inline(block.text),
                    role = if (block.level <= 3) TextRole.Prose else TextRole.Base,
                    weight = FontWeight.Medium,
                    modifier = Modifier.padding(top = if (block.level <= 3) 6.dp else 2.dp)
                )

                is MdBlock.Paragraph -> AgenteText(text = inline(block.text), role = TextRole.Prose)

                is MdBlock.Bullets -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEach { item ->
                        MarkerRow(marker = "\u2022") { AgenteText(inline(item), role = TextRole.Prose) }
                    }
                }

                is MdBlock.Numbers -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEachIndexed { index, item ->
                        MarkerRow(marker = "${index + 1}.") { AgenteText(inline(item), role = TextRole.Prose) }
                    }
                }

                is MdBlock.Tasks -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEach { (done, item) ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AgenteIcon(
                                icon = if (done) R.drawable.agente_ic_check else R.drawable.agente_ic_square,
                                contentDescription = null,
                                size = 14.dp,
                                tint = if (done) colors.accent else colors.mutedForeground,
                                modifier = Modifier.padding(top = 4.dp)
                            )
                            AgenteText(inline(item), role = TextRole.Prose, color = if (done) colors.mutedForeground else colors.foreground)
                        }
                    }
                }

                is MdBlock.Quote -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(
                        modifier = Modifier
                            .width(2.dp)
                            .height(20.dp)
                            .background(colors.line)
                    )
                    AgenteText(inline(block.text), role = TextRole.Prose, color = colors.secondary)
                }

                MdBlock.Rule -> AgenteSeparator(inset = 0.dp)

                is MdBlock.Code -> AgenteCodeBlock(block.body, block.language)

                is MdBlock.Table -> AgenteTable(block.headers, block.rows)
            }
        }
    }
}

@Composable
private fun MarkerRow(marker: String, content: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AgenteText(
            text = marker,
            role = TextRole.Prose,
            color = AgenteTheme.colors.mutedForeground,
            modifier = Modifier.width(18.dp)
        )
        Box(modifier = Modifier.weight(1f)) { content() }
    }
}

/** Code is mono, on the card plane, scrolling sideways, with its own copy. */
@Composable
fun AgenteCodeBlock(code: String, language: String?, modifier: Modifier = Modifier) {
    val colors = AgenteTheme.colors
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
            .background(colors.card)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AgenteText(
                text = language?.takeIf { it.isNotBlank() } ?: "",
                role = TextRole.Caption,
                color = colors.mutedForeground,
                modifier = Modifier.weight(1f),
                maxLines = 1
            )
            AgenteIconButton(
                icon = if (copied) R.drawable.agente_ic_check else R.drawable.agente_ic_copy,
                contentDescription = null,
                onClick = {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    clipboard?.setPrimaryClip(ClipData.newPlainText("agente", code))
                    copied = true
                },
                size = 28.dp,
                glyph = 14.dp,
                tint = if (copied) colors.accent else colors.mutedForeground
            )
        }
        Box(modifier = Modifier.horizontalScroll(rememberScrollState())) {
            AgenteText(
                text = code,
                role = TextRole.Code,
                color = colors.foreground,
                softWrap = false
            )
        }
    }
}

/** A table scrolls sideways rather than wrapping into soup. */
@Composable
private fun AgenteTable(headers: List<String>, rows: List<List<String>>) {
    val colors = AgenteTheme.colors
    val columnWidth = 132.dp
    Column(modifier = Modifier.horizontalScroll(rememberScrollState())) {
        Row(modifier = Modifier.padding(vertical = 4.dp)) {
            headers.forEach { header ->
                AgenteText(
                    text = header,
                    role = TextRole.Caption,
                    color = colors.mutedForeground,
                    weight = FontWeight.Medium,
                    modifier = Modifier.width(columnWidth).padding(end = 12.dp),
                    maxLines = 2
                )
            }
        }
        AgenteSeparator(inset = 0.dp)
        rows.forEach { row ->
            Row(modifier = Modifier.padding(vertical = 6.dp)) {
                row.forEach { cell ->
                    AgenteText(
                        text = inline(cell),
                        role = TextRole.Small,
                        modifier = Modifier.width(columnWidth).padding(end = 12.dp)
                    )
                }
            }
            AgenteSeparator(inset = 0.dp)
        }
    }
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    data class Bullets(val items: List<String>) : MdBlock
    data class Numbers(val items: List<String>) : MdBlock
    data class Tasks(val items: List<Pair<Boolean, String>>) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class Code(val language: String, val body: String) : MdBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdBlock
    data object Rule : MdBlock
}

private val HEADING = Regex("^(#{1,6})\\s+(.*)$")
private val RULE = Regex("^(-{3,}|\\*{3,}|_{3,})$")
private val TASK = Regex("^[-*+]\\s+\\[([ xX])]\\s+(.*)$")
private val BULLET = Regex("^[-*+]\\s+(.*)$")
private val NUMBER = Regex("^\\d+[.)]\\s+(.*)$")
private val QUOTE = Regex("^>\\s?(.*)$")
private val TABLE_DIVIDER = Regex("^\\|?[\\s:|-]+\\|?$")

/** Blocks only; inline spans are resolved at render time by [inline]. */
fun parseMarkdown(text: String): List<MdBlock> {
    val lines = text.replace("\r\n", "\n").split('\n')
    val blocks = mutableListOf<MdBlock>()
    var index = 0

    while (index < lines.size) {
        val line = lines[index]
        val trimmed = line.trim()

        when {
            trimmed.isEmpty() -> index += 1

            trimmed.startsWith("```") -> {
                val language = trimmed.removePrefix("```").trim()
                val body = mutableListOf<String>()
                index += 1
                while (index < lines.size && !lines[index].trim().startsWith("```")) {
                    body.add(lines[index])
                    index += 1
                }
                index += 1
                blocks.add(MdBlock.Code(language, body.joinToString("\n")))
            }

            trimmed.startsWith("|") && index + 1 < lines.size && TABLE_DIVIDER.matches(lines[index + 1].trim()) -> {
                val headers = cells(trimmed)
                val rows = mutableListOf<List<String>>()
                index += 2
                while (index < lines.size && lines[index].trim().startsWith("|")) {
                    rows.add(cells(lines[index].trim()))
                    index += 1
                }
                blocks.add(MdBlock.Table(headers, rows))
            }

            HEADING.matches(trimmed) -> {
                val match = HEADING.matchEntire(trimmed)!!
                blocks.add(MdBlock.Heading(match.groupValues[1].length, match.groupValues[2].trim()))
                index += 1
            }

            RULE.matches(trimmed) -> {
                blocks.add(MdBlock.Rule)
                index += 1
            }

            TASK.matches(trimmed) -> {
                val items = mutableListOf<Pair<Boolean, String>>()
                while (index < lines.size && TASK.matches(lines[index].trim())) {
                    val match = TASK.matchEntire(lines[index].trim())!!
                    items.add(match.groupValues[1].isNotBlank() to match.groupValues[2].trim())
                    index += 1
                }
                blocks.add(MdBlock.Tasks(items))
            }

            BULLET.matches(trimmed) -> {
                val items = mutableListOf<String>()
                while (index < lines.size && BULLET.matches(lines[index].trim())) {
                    items.add(BULLET.matchEntire(lines[index].trim())!!.groupValues[1].trim())
                    index += 1
                }
                blocks.add(MdBlock.Bullets(items))
            }

            NUMBER.matches(trimmed) -> {
                val items = mutableListOf<String>()
                while (index < lines.size && NUMBER.matches(lines[index].trim())) {
                    items.add(NUMBER.matchEntire(lines[index].trim())!!.groupValues[1].trim())
                    index += 1
                }
                blocks.add(MdBlock.Numbers(items))
            }

            QUOTE.matches(trimmed) -> {
                val quoted = mutableListOf<String>()
                while (index < lines.size && QUOTE.matches(lines[index].trim())) {
                    quoted.add(QUOTE.matchEntire(lines[index].trim())!!.groupValues[1].trim())
                    index += 1
                }
                blocks.add(MdBlock.Quote(quoted.joinToString(" ")))
            }

            else -> {
                val paragraph = mutableListOf<String>()
                while (index < lines.size && lines[index].trim().isNotEmpty() && !startsBlock(lines[index].trim())) {
                    paragraph.add(lines[index].trim())
                    index += 1
                }
                if (paragraph.isEmpty()) {
                    // A block start the parser does not know: keep the line as prose.
                    paragraph.add(trimmed)
                    index += 1
                }
                blocks.add(MdBlock.Paragraph(paragraph.joinToString("\n")))
            }
        }
    }
    return blocks
}

private fun startsBlock(trimmed: String): Boolean =
    trimmed.startsWith("```") ||
        trimmed.startsWith("|") ||
        HEADING.matches(trimmed) ||
        RULE.matches(trimmed) ||
        TASK.matches(trimmed) ||
        BULLET.matches(trimmed) ||
        NUMBER.matches(trimmed) ||
        QUOTE.matches(trimmed)

private fun cells(line: String): List<String> =
    line.trim().trim('|').split('|').map { it.trim() }

private val INLINE = Regex(
    "(\\*\\*|__)(.+?)\\1" +          // bold
        "|(\\*|_)(.+?)\\3" +          // italic
        "|`([^`]+)`" +                // inline code
        "|~~(.+?)~~" +                // strikethrough
        "|\\[([^\\]]+)]\\(([^)\\s]+)\\)" // link
)

/** One level of inline spans, the constructs the desktop's parser also keeps flat. */
@Composable
private fun inline(text: String): AnnotatedString {
    val colors = AgenteTheme.colors
    val type = AgenteTheme.type
    return remember(text, colors) {
        buildAnnotatedString {
            var cursor = 0
            for (match in INLINE.findAll(text)) {
                if (match.range.first > cursor) append(text.substring(cursor, match.range.first))
                val groups = match.groupValues
                when {
                    groups[2].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(groups[2]) }
                    groups[4].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(groups[4]) }
                    groups[5].isNotEmpty() -> withStyle(
                        SpanStyle(
                            fontFamily = type.code.fontFamily,
                            fontSize = type.code.fontSize,
                            background = colors.muted,
                            color = colors.foreground
                        )
                    ) { append(groups[5]) }
                    groups[6].isNotEmpty() -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(groups[6]) }
                    groups[7].isNotEmpty() -> withStyle(SpanStyle(color = colors.accent)) { append(groups[7]) }
                }
                cursor = match.range.last + 1
            }
            if (cursor < text.length) append(text.substring(cursor))
        }
    }
}
