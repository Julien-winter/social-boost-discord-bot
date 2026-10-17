# Social Boost Discord Bot

Ein Discord-Bot mit Slash-Commands und einem Nachrichten-Panel. Bestellungen laufen über eine interne Queue; Status, Services und Guthaben werden nur auf Anfrage abgefragt. Ein Rate Limit schützt die API, und Admins können die Queue pausieren, fortsetzen, leeren und einsehen.

## Start

1. Node.js 20 oder neuer installieren.
2. `npm install` ausführen.
3. `.env.example` nach `.env` kopieren und `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` und `BOOST_API_KEY` eintragen. Der Schlüssel bleibt ausschließlich in `.env`.
4. Den Bot mit den Scopes `bot` und `applications.commands` auf den Server einladen.
5. Mit `npm start` starten.

Für schnelle Slash-Command-Updates kann `DISCORD_GUILD_ID` gesetzt werden. Ohne diese Variable werden globale Commands registriert, was bei Discord länger dauern kann.

## Commands

- `/panel` öffnet das Nachrichten-Panel.
- `/services`, `/balance`, `/status order:<id>` lesen Informationen aus der API.
- `/order service:<id> link:<url> quantity:<menge> [runs] [interval]` stellt eine Bestellung in die Queue.
- `/admin panel|queue|pause|resume|clear` ist nur für IDs in `ADMIN_USER_IDS` oder Rollen in `ADMIN_ROLE_IDS` verfügbar.

Der Bot zeigt im Discord keine Anbieter-Marke. Die API-Adresse steht nur in der lokalen Konfiguration, weil sie für die Verbindung benötigt wird. Keine Live-Bestellung wird beim Setup ausgeführt.

## Sicherheit

Den Testschlüssel nicht committen und nach dem Test im Anbieter-Konto widerrufen/ändern. Rate Limits, Admin-IDs und API-Schlüssel gehören in `.env` bzw. in den Secret Store des Deployments.
