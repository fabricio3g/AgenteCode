package dev.agente.android.ui.code

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.agente.android.R
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.TextRole

/**
 * Code on the phone is a landing page and nothing else: a paired computer, its
 * projects and its sessions arrive with the desktop connection. Until that
 * ships, this space says so plainly rather than showing work it cannot do.
 */
@Composable
fun CodeScreen() {
    val colors = AgenteTheme.colors
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = AgenteMetrics.gutter, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        AgenteText(
            text = stringResource(R.string.code_title),
            role = TextRole.Prose,
            color = colors.foreground,
            weight = FontWeight.Medium
        )
        AgenteText(
            text = stringResource(R.string.code_headline),
            role = TextRole.Base,
            color = colors.secondary
        )
        AgenteText(
            text = stringResource(R.string.code_body),
            role = TextRole.Small,
            color = colors.mutedForeground
        )
    }
}
