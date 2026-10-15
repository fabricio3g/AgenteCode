package dev.agente.android

import org.junit.Assert.assertEquals
import org.junit.Test

class RoleplayNamesTest {
    @Test fun personaSwitchResolvesTheSameStoredGreetingAgain() {
        val stored = "{{char}} waves. Welcome, {{user}}."
        assertEquals("Mira waves. Welcome, Alex.", resolveNames(stored, "Mira", "Alex"))
        assertEquals("Mira waves. Welcome, Sam.", resolveNames(stored, "Mira", "Sam"))
        assertEquals("{{char}} waves. Welcome, {{user}}.", stored)
    }
}
