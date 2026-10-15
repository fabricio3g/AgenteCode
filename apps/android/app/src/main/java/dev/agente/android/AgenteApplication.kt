package dev.agente.android

import android.app.Application
import androidx.room.Room
import dev.agente.android.data.AgenteDatabase
import dev.agente.android.data.CredentialVault
import dev.agente.android.data.Preferences
import dev.agente.android.data.Repository

class AgenteApplication : Application() {
    val preferences by lazy { Preferences(this) }
    val vault by lazy { CredentialVault(this) }
    val database by lazy { Room.databaseBuilder(this, AgenteDatabase::class.java, "agente.db").build() }
    val repository by lazy { Repository(database, preferences.deviceId) }
}
