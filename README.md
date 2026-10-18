# Social Boost Discord Bot

A Discord bot with slash commands and a message panel. Orders pass through an internal queue; services, balances and order statuses are fetched on demand. Rate limits protect the API, and admins can pause, resume, inspect and clear the queue.

Each Discord user has a separate persistent credit balance. Orders reserve credits before entering the queue and automatically refund them if the provider rejects the order. Crypto deposits are optional and use NOWPayments IPN signature verification; the bot never credits a payment from an unsigned webhook or from a browser callback. The service browser includes platform filters for TikTok, YouTube, Twitch and other detected platforms, and clearly separates provider pricing from the reseller price.

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
- `/services` lists provider services, `/balance` shows your private credits, and `/status order:<id>` reads an order status.
- `/order service:<id> link:<url> quantity:<amount> [runs] [interval]` adds an order to the queue.
- `/credits` shows your private credit balance.
- `/deposit amount:<amount>` creates a crypto payment and credits the user after a verified provider webhook.
- `/admin panel|queue|pause|resume|clear` is restricted to IDs in `ADMIN_USER_IDS` or roles in `ADMIN_ROLE_IDS`.

## Credits and crypto deposits

The bot stores credits in `DATA_DIR/credits.json`, which is ignored by Git. Set `CREDIT_RATE_DIVISOR` to match the provider's rate unit. With the default value of `1000`, a provider rate of `1.50` and quantity `1000` costs `1.50 USD`.

`PROFIT_PERCENT` controls the reseller margin. For example, `PROFIT_PERCENT=20` turns a provider rate of 1.50 USD per 1,000 units into a customer price of 1.80 USD per 1,000 units. The same customer price is used for credit reservations, so the displayed price and charged amount stay aligned. `CREDIT_RATE_DIVISOR` defines the quantity unit used by the provider rate.

For optional crypto deposits, create a NOWPayments API key and IPN secret, expose `POST /crypto/webhook` through HTTPS, and set `CRYPTO_API_KEY`, `CRYPTO_IPN_SECRET`, `CRYPTO_CALLBACK_URL`, `CRYPTO_PRICE_CURRENCY`, `CRYPTO_PAY_CURRENCY` and `CRYPTO_WEBHOOK_PORT`. Use sandbox mode first. Never expose these secrets or manually mark a deposit as paid.

## Security

Do not commit API keys, Discord tokens or `.env` files. Keep secrets in `.env` locally or in your deployment provider's secret store. No live order is submitted during setup.
