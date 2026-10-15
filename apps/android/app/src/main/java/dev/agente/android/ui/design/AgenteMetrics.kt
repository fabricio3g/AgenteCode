package dev.agente.android.ui.design

import androidx.compose.ui.unit.dp

/**
 * The phone's own geometry: every value here is a deliberate adaptation of a
 * desktop measurement for a finger and a smaller screen, and the reason travels
 * with it. Anything that is *not* an adaptation comes from [AgenteTokens], which
 * is generated from the desktop's token sheet.
 */
object AgenteMetrics {
    /** The desktop's row is 32dp tall for a pointer; a thumb needs 44dp. The
     *  rest of the recipe (radius, inset, gap, 13sp label) is unchanged. */
    val rowHeight = 44.dp

    /** A glyph button's box: the 16dp desktop glyph sits in a 40dp hit area. */
    val iconButton = 40.dp

    /** Chrome glyphs. The desktop draws 16dp on a 44px rail; the phone is held
     *  further away, so the same drawing reads at 20dp. */
    val glyph = 20.dp

    /** In-row glyph: the desktop's `--sidebar-icon` (16dp) unchanged. */
    val rowGlyph = 16.dp

    /** A bubble's radius: the phone's own convention. The desktop has no chat
     *  bubble — your prompt there is a card with an accent rail — so there is no
     *  token to inherit, and 20dp is what a filled bubble reads best at. */
    val bubbleRadius = 20.dp

    /** Top strip: title, then glyph actions hard right. */
    val topStrip = 48.dp

    /** Page inset, the desktop's `px-4`. */
    val gutter = 16.dp

    /** The row recipe's horizontal inset (`.sidebar-row` padding 0 .625rem). */
    val rowInset = 10.dp

    /** The mosaic's cell, from `GreetingTiles` (0.875rem). */
    val tileCell = 14.dp
}
