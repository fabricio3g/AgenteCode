package dev.agente.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The boundary that keeps the phone on the desktop's design language.
 *
 * The desktop has the same rule in `control-migration.spec.ts`: a screen may not
 * reach past the shared library for a control. Here the library is `ui/design`,
 * and the thing it may not reach past is a component framework — one Material
 * import in a screen is how a port starts looking like a Material app again.
 */
class DesignBoundaryTest {

    private val sources = File("src/main/java")

    private fun kotlinFiles(): List<File> {
        assertTrue("no Kotlin sources under ${sources.absolutePath}", sources.isDirectory)
        return sources.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    }

    @Test
    fun `no component framework in the app`() {
        val offenders = kotlinFiles().flatMap { file ->
            file.readLines().withIndex().filter { (_, line) ->
                val code = line.substringBefore("//")
                code.contains("androidx.compose.material")
            }.map { (index, line) -> "${file.path}:${index + 1}: ${line.trim()}" }
        }
        assertEquals(
            "screens and the design system draw with Compose foundation only; " +
                "these reach for a component library instead:\n" + offenders.joinToString("\n"),
            emptyList<String>(),
            offenders
        )
    }

    @Test
    fun `generated tokens are the only palette`() {
        // A hex literal outside the generated token file is a second palette
        // being born, which is exactly how the phone drifted from the desktop.
        val allowed = setOf("ui/design/AgenteTokens.kt")
        val offenders = kotlinFiles().filterNot { file ->
            allowed.any { file.path.endsWith(it) }
        }.flatMap { file ->
            file.readLines().withIndex().filter { (_, line) ->
                val code = line.substringBefore("//")
                Regex("0x[0-9A-Fa-f]{8}").containsMatchIn(code)
            }.map { (index, line) -> "${file.path}:${index + 1}: ${line.trim()}" }
        }
        assertEquals(
            "colours come from AgenteTokens (generated from the desktop's sheet):\n" + offenders.joinToString("\n"),
            emptyList<String>(),
            offenders
        )
    }
}
