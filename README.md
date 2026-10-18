# Social Boost Discord Bot

A Discord bot with slash commands and a message panel. Orders pass through an internal queue; services, balances and order statuses are fetched on demand. Rate limits protect the API, and admins can pause, resume, inspect and clear the queue.

The API integration uses the [PandaBoost API](https://pandaboost.de). See the [PandaBoost API documentation](https://pandaboost.de) for the provider details.

## Get an API key

1. Sign in at [pandaboost.de](https://pandaboost.de).
2. Open the [Account page](https://pandaboost.de/account).
3. Scroll down to the **API key** section.
4. Click **Generate new**. The new key appears in the API key field.
5. Copy it immediately and store it only in `.env` as `BOOST_API_KEY`:

```env
BOOST_API_KEY=your_api_key
BOOST_API_URL=https://pandaboost.de/api/v2
```

Do not leave `BOOST_API_URL=https://your-provider.example/api/v2` in `.env`; that value is only a placeholder and causes `ENOTFOUND your-provider.example`.

Never publish the key in GitHub, screenshots, logs or Discord messages. If it is exposed, use **Generate new** on the Account page to rotate it.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `BOOST_API_KEY`.
4. Invite the bot with the `bot` and `applications.commands` scopes.
5. Start it with `npm start`.

Set `DISCORD_GUILD_ID` for faster slash-command updates during development. Without it, commands are registered globally and Discord may take longer to publish them.

If startup reports `Missing Access`, verify that `DISCORD_CLIENT_ID` is the Application ID for the same bot token, that `DISCORD_GUILD_ID` is the correct server ID, and that the bot was invited to that server with both `bot` and `applications.commands` scopes. The bot now stays online and logs this diagnosis instead of crashing.

## Commands

- `/panel` opens the message panel.
- `/services`, `/balance` and `/status order:<id>` read information from the API.
- `/order service:<id> link:<url> quantity:<amount> [runs] [interval]` adds an order to the queue.
- `/admin panel|queue|pause|resume|clear` is restricted to IDs in `ADMIN_USER_IDS` or roles in `ADMIN_ROLE_IDS`.

## Security

Do not commit API keys, Discord tokens or `.env` files. Keep secrets in `.env` locally or in your deployment provider's secret store. No live order is submitted during setup.
