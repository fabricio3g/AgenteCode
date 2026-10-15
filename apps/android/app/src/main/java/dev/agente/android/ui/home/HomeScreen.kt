package dev.agente.android.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.agente.android.AgenteViewModel
import dev.agente.android.R
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgenteSuggestionCard
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.GreetingTiles
import dev.agente.android.ui.design.TextRole

/**
 * Home's landing: the greeting, and the four starters that teach what the app is
 * for. The conversations are one plane over, in the drawer, so this canvas holds
 * only the way in. The block centres itself while it fits and scrolls once the
 * text scale makes it taller than the screen.
 */
@Composable
fun HomeScreen(model: AgenteViewModel) {
    val colors = AgenteTheme.colors
    val labels = STARTERS.map { stringResource(it.labelRes) }
    val prompts = STARTERS.map { stringResource(it.promptRes) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        contentAlignment = Alignment.Center
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = AgenteMetrics.gutter)) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 12.dp),
                contentAlignment = Alignment.Center
            ) {
                GreetingTiles()
            }
            AgenteText(
                text = stringResource(R.string.home_greeting),
                role = TextRole.Greeting,
                color = colors.foreground,
                weight = FontWeight.Medium,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 22.dp)
            )
            // Two by two: four starters read at a glance, and the grid keeps the
            // landing from turning into a list of rows above the composer.
            STARTERS.chunked(2).forEach { pair ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    pair.forEach { starter ->
                        val index = STARTERS.indexOf(starter)
                        AgenteSuggestionCard(
                            label = labels[index],
                            icon = starter.icon,
                            hue = starter.hue,
                            onClick = { model.updateDraft(prompts[index]) },
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }
        }
    }
}

private class Starter(val labelRes: Int, val promptRes: Int, val icon: Int, val hue: Float)

/**
 * The starters, in the desktop's order, each glyph in its kind's own hue so the
 * job is recognisable before the label is read. Picking one fills the composer
 * and never sends, so a mis-tap costs nothing.
 */
private val STARTERS = listOf(
    Starter(R.string.starter_weather_label, R.string.starter_weather_prompt, R.drawable.agente_ic_cloud_sun, 230f),
    Starter(R.string.starter_code_label, R.string.starter_code_prompt, R.drawable.agente_ic_code_xml, 280f),
    Starter(R.string.starter_write_label, R.string.starter_write_prompt, R.drawable.agente_ic_pen_line, 40f),
    Starter(R.string.starter_brainstorm_label, R.string.starter_brainstorm_prompt, R.drawable.agente_ic_lightbulb, 85f)
)
