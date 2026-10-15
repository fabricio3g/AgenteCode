package dev.agente.android.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.agente.android.AgenteViewModel
import dev.agente.android.R
import dev.agente.android.data.ChatMessage
import dev.agente.android.resolveNames
import dev.agente.android.ui.design.AgenteGlyphButton
import dev.agente.android.ui.design.AgenteJumpToLatest
import dev.agente.android.ui.design.AgenteMarkdown
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgenteRunLine
import dev.agente.android.ui.design.AgenteThoughtRow
import dev.agente.android.ui.design.AgenteUserBubble
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The thread. Your turn is a bubble on the right; the answer is prose on the
 * canvas, with the model's reasoning folded above it and its own actions below.
 * New output is followed only while the reader is already at the bottom.
 */
@Composable
fun TranscriptScreen(model: AgenteViewModel) {
    val list = rememberLazyListState()
    var follows by remember(model.activeChat?.id) { mutableStateOf(true) }
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to list.canScrollForward }.distinctUntilChanged().collect { (scrolling, forward) ->
            if (scrolling) follows = !forward
        }
    }
    LaunchedEffect(follows, model.messages.size, model.messages.lastOrNull()?.content?.length) {
        if (follows && model.messages.isNotEmpty()) list.scrollToItem(model.messages.lastIndex)
    }
    Box(modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = list,
            contentPadding = PaddingValues(
                start = AgenteMetrics.gutter,
                end = AgenteMetrics.gutter,
                top = 8.dp,
                bottom = 18.dp
            ),
            verticalArrangement = Arrangement.spacedBy(22.dp)
        ) {
            items(model.messages, key = { it.id }) { message ->
                MessageRow(message, model)
            }
        }
        if (!follows && list.canScrollForward) {
            AgenteJumpToLatest(
                onClick = { follows = true },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 14.dp)
            )
        }
    }
}

@Composable
private fun MessageRow(message: ChatMessage, model: AgenteViewModel) {
    val character = model.characters.firstOrNull { it.id == model.activeChat?.characterId }
    val persona = model.selection.persona
    val displayed = remember(message.content, character?.name, persona) {
        resolveNames(message.content, character?.name.orEmpty(), persona)
    }
    if (message.role == "user") {
        AgenteUserBubble(displayed)
        return
    }
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (message.thinking.isNotBlank()) {
            AgenteThoughtRow(resolveNames(message.thinking, character?.name.orEmpty(), persona))
        }
        when {
            displayed.isNotBlank() -> {
                AgenteMarkdown(displayed)
                AnswerActions(text = displayed, model = model, message = message)
            }
            message.status == "streaming" -> AgenteRunLine(label = stringResource(R.string.status_working), busy = false)
            else -> AgenteRunLine(label = stringResource(R.string.thread_generation_failed), busy = false)
        }
    }
}

/**
 * An answer's own actions. Only what works is here: copy and share are real,
 * and regenerate re-runs the turn from the same user message. Feedback and
 * version navigation wait for a backend and for message alternatives.
 */
@Composable
private fun AnswerActions(text: String, model: AgenteViewModel, message: ChatMessage) {
    val context = LocalContext.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        AgenteGlyphButton(
            icon = R.drawable.agente_ic_copy,
            contentDescription = stringResource(R.string.action_copy),
            onClick = { copyToClipboard(context, text) }
        )
        AgenteGlyphButton(
            icon = R.drawable.agente_ic_refresh_cw,
            contentDescription = stringResource(R.string.action_retry),
            onClick = { model.regenerate(message.id) }
        )
        AgenteGlyphButton(
            icon = R.drawable.agente_ic_share_2,
            contentDescription = stringResource(R.string.action_share),
            onClick = { share(context, text) }
        )
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("agente", text))
}

private fun share(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(send, null))
}
