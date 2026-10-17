# Social Boost Discord Bot

Ein Discord-Bot mit Slash-Commands und einem Nachrichten-Panel. Bestellungen laufen über eine interne Queue; Status, Services und Guthaben werden nur auf Anfrage abgefragt. Ein Rate Limit schützt die API, und Admins können die Queue pausieren, fortsetzen, leeren und einsehen.

Die API-Anbindung verwendet die [PandaBoost API](https://pandaboost.de). Die API-Dokumentation ist unter [pandaboost.de](https://pandaboost.de) erreichbar.

## API-Key holen

1. Bei [pandaboost.de](https://pandaboost.de) anmelden.
2. Die [Account-Seite](https://pandaboost.de/account) öffnen.
3. Auf der Account-Seite nach unten zum Abschnitt **API key** scrollen.
4. Dort **Generate new** klicken. Der neue Schlüssel wird anschließend im API-key-Feld angezeigt.
5. Den Schlüssel sofort kopieren und nur lokal in `.env` bei `BOOST_API_KEY` eintragen:

```env
BOOST_API_KEY=dein_api_key
BOOST_API_URL=https://pandaboost.de/api/v2
```

Den Schlüssel niemals in GitHub, Screenshots, Logs oder Discord-Nachrichten veröffentlichen. Wenn ein Schlüssel versehentlich geteilt wurde, auf der Account-Seite mit **Generate new** ersetzen.

## Start

1. Node.js 20 oder neuer installieren.
2. `npm install` ausführen.
3. `.env.example` nach `.env` kopieren und `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` und `BOOST_API_KEY` eintragen.
4. Den Bot mit den Scopes `bot` und `applications.commands` auf den Server einladen.
5. Mit `npm start` starten.

Für schnelle Slash-Command-Updates kann `DISCORD_GUILD_ID` gesetzt werden. Ohne diese Variable werden globale Commands registriert, was bei Discord länger dauern kann.

## Commands

- `/panel` öffnet das Nachrichten-Panel.
- `/services`, `/balance`, `/status order:<id>` lesen Informationen aus der API.
- `/order service:<id> link:<url> quantity:<menge> [runs] [interval]` stellt eine Bestellung in die Queue.
- `/admin panel|queue|pause|resume|clear` ist nur für IDs in `ADMIN_USER_IDS` oder Rollen in `ADMIN_ROLE_IDS` verfügbar.

## Sicherheit

Den Testschlüssel nicht committen und nach dem Test im Anbieter-Konto widerrufen oder ändern. Rate Limits, Admin-IDs und API-Schlüssel gehören in `.env` beziehungsweise in den Secret Store des Deployments.
