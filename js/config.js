/*
 * Retrac storefront config.
 * Every brand detail, price, link and payout destination lives here and nowhere else.
 * Edit this file, reload, done. Nothing below ships with a real value baked into the HTML.
 */
window.RETRAC_CONFIG = {
  brand: {
    siteName: "Odium",
    productName: "Retrac External",
    productTagline: "External aimbot and advanced ESP. No injection, stream-proof, lifetime updates.",
    domain: "getodium.shop",
    origin: "https://getodium.shop",
    discordInvite: "https://discord.gg/odium",
    supportDiscord: "dx5c",
    supportEmail: "support@getodium.shop",
    founderDisplay: "dx5c"
  },

  product: {
    id: "retrac-external",
    price: 3.00,
    currency: "USD",
    priceLabel: "$3.00",
    // Order references are generated client side as RET-XXXXXX; prefix is what the buyer
    // puts in a payment note so a manual payment can be matched to a ticket.
    orderPrefix: "RET",
    deliveryWindow: "5-30 minutes",
    includes: [
      "Full Retrac External license",
      "Aimbot suite + advanced ESP",
      "Lifetime updates and rebuilds",
      "Dashboard account + cloud configs",
      "HWID reset requests",
      "Buyer Discord role and priority support"
    ]
  },

  payments: {
    crypto: {
      label: "Crypto",
      blurb: "BTC, ETH, LTC, USDT (TRC-20 / ERC-20), SOL, XMR",
      enabled: true,
      // mode "invoice" -> hosted checkout from a processor (recommended, auto-confirms).
      // mode "address" -> you print your own addresses and confirm manually.
      mode: "invoice",
      invoiceUrl: "https://nowpayments.io/payment/?iid=REPLACE_WITH_INVOICE_ID",
      addresses: {
        BTC:  "REPLACE_BTC_ADDRESS",
        ETH:  "REPLACE_ETH_ADDRESS",
        LTC:  "REPLACE_LTC_ADDRESS",
        USDT_TRC20: "REPLACE_USDT_TRC20_ADDRESS",
        SOL:  "REPLACE_SOL_ADDRESS",
        XMR:  "REPLACE_XMR_ADDRESS"
      },
      confirmations: "1 confirmation (BTC/ETH 3 confs) before key release"
    },

    paypal: {
      label: "PayPal",
      blurb: "PayPal balance, linked bank or card. Instant confirmation.",
      enabled: true,
      // "sdk"   -> Smart Buttons against server/ (sandbox or live, set by PAYPAL_MODE)
      // "link"  -> paypal.me link, live accounts only, matched by hand
      // "email" -> print the address and wait for a manual transfer
      mode: "sdk",
      // "" = same origin as the site. Set a full URL only when the API is hosted elsewhere.
      apiBase: "",
      link: "https://paypal.me/REPLACE_ME/3.00",
      email: "REPLACE_PAYPAL_EMAIL",
      // Fallback note shown in link/email modes.
      note: "Send as Goods & Services and put your order reference in the note."
    },

    cashapp: {
      label: "Cash App",
      blurb: "Instant, US only, no fee to the buyer.",
      enabled: true,
      cashtag: "$REPLACE_CASHTAG",
      link: "https://cash.app/$REPLACE_CASHTAG",
      note: "Put your order reference in the payment note. Do not send more than the listed amount."
    },

    stripe: {
      label: "Card / Stripe",
      blurb: "Visa, Mastercard, Amex, Apple Pay, Google Pay.",
      enabled: true,
      // Create a Stripe Payment Link (one product, one price) and paste it here.
      paymentLink: "https://buy.stripe.com/REPLACE_WITH_PAYMENT_LINK",
      // Optional: a hosted checkout session endpoint if you build one later.
      checkoutEndpoint: ""
    }
  },

  currency: {
    symbol: "$",
    code: "USD"
  }
};
