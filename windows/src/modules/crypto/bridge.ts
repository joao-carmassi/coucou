import { commandOrThrow } from "../../kit/tauri";
import type { Fiat, Portfolio, Price, Status, Wallet } from "./logic";

export const cryptoBridge = {
  prices: (coins: string[], fiat: Fiat) => commandOrThrow<Price[]>("crypto_prices", { coins, fiat }),
  portfolio: (fiat: Fiat) => commandOrThrow<Portfolio>("crypto_portfolio", { fiat }),
  status: () => commandOrThrow<Status>("crypto_status"),
  connect: (exchange: "coinbase" | "okx", fields: Record<string, string>) => commandOrThrow<null>("crypto_connect", { exchange, fields }),
  disconnect: (exchange: "coinbase" | "okx") => commandOrThrow<null>("crypto_disconnect", { exchange }),
  wallets: () => commandOrThrow<Wallet[]>("crypto_wallets"),
  walletAdd: (kind: string, addr: string) => commandOrThrow<null>("crypto_wallet_add", { kind, addr }),
  walletRemove: (slot: number) => commandOrThrow<null>("crypto_wallet_remove", { slot }),
};
