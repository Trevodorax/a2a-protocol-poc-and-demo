/**
 * Static bank knowledge the agent can look up (fees, procedures, opening hours...).
 *
 * WHY a searchable knowledge base instead of pasting everything into the system prompt?
 * - Today the content is small and *could* live in the prompt. But a real bank has hundreds of
 *   pages of product terms. Putting them behind a `search_knowledge_base` tool keeps the system
 *   prompt short and stable, and lets the content grow (or move to a real search engine / vector
 *   store) without changing the agent's prompt or its prompt cache.
 * - It also gives us an audit trail: every answer about fees or procedures can be traced back to
 *   the article ids the agent retrieved (they show up in tool calls), which matters for a
 *   regulated business.
 * - The system prompt tells the agent that this is the *only* source of truth for bank policies,
 *   so it doesn't fall back on general knowledge about "how banks usually do it", which would
 *   be wrong for our bank.
 *
 * The bank and every number below are fictional.
 */

export const BANK_NAME = "Atlas Bank";

export interface KnowledgeArticle {
  id: string;
  title: string;
  /** Lower-case terms (FR + EN, since clients write in both) used by the naive search below. */
  keywords: readonly string[];
  content: string;
}

export const KNOWLEDGE_BASE: readonly KnowledgeArticle[] = [
  {
    id: "kb_contact_hours",
    title: "Contact channels and opening hours",
    keywords: ["hours", "horaires", "contact", "phone", "téléphone", "agence", "branch", "open", "ouvert", "advisor", "conseiller"],
    content:
      "Branches are open Monday to Friday 9:00-18:00 and Saturday 9:00-12:30. " +
      "Phone support: +33 1 00 00 00 00, Monday to Saturday 8:00-20:00. " +
      "Clients can book an appointment with their advisor from the mobile app (Profile > My advisor).",
  },
  {
    id: "kb_lost_stolen_card",
    title: "Lost or stolen card",
    keywords: ["lost", "stolen", "perdue", "volée", "vol", "perte", "block", "bloquer", "opposition", "fraud", "fraude"],
    content:
      "A lost or stolen card must be blocked immediately. Blocking is permanent and cannot be undone. " +
      "The emergency blocking line is available 24/7: +33 1 00 00 00 99. " +
      "A replacement card is sent automatically within 5 business days after a block, free of charge for lost or stolen cards. " +
      "If unauthorized payments were made, the client must also file a dispute; an advisor handles disputes.",
  },
  {
    id: "kb_card_fees",
    title: "Card fees",
    keywords: ["fee", "fees", "frais", "card", "carte", "cotisation", "annual", "annuelle", "abroad", "étranger", "withdrawal", "retrait"],
    content:
      "Visa Classic: 45 EUR per year. Mastercard Gold: 120 EUR per year. " +
      "Payments in EUR are free. Payments in other currencies: 2% of the amount. " +
      "Cash withdrawals at Atlas Bank ATMs are free; at other banks' ATMs in the eurozone, 3 free per month then 1 EUR each; outside the eurozone, 3 EUR + 2%.",
  },
  {
    id: "kb_transfers",
    title: "Transfers (SEPA and international)",
    keywords: ["transfer", "virement", "sepa", "international", "swift", "instant", "instantané", "iban", "delay", "délai"],
    content:
      "SEPA transfers are free and arrive within 1 business day. Instant SEPA transfers are free and arrive within 10 seconds, up to 15,000 EUR. " +
      "International (non-SEPA) transfers cost 15 EUR + 0.1% of the amount and take 2 to 5 business days. " +
      "Transfers are made from the mobile app or online banking; the agent cannot make transfers on the client's behalf.",
  },
  {
    id: "kb_overdraft",
    title: "Authorized overdraft",
    keywords: ["overdraft", "découvert", "negative", "négatif", "agios", "interest", "intérêts"],
    content:
      "Checking accounts can have an authorized overdraft, set by the advisor based on the client's income. " +
      "Interest on the overdraft: 14.9% annual rate, charged quarterly. Exceeding the authorized limit incurs an 8 EUR fee per rejected payment. " +
      "Changing the overdraft limit requires an advisor.",
  },
  {
    id: "kb_savings",
    title: "Savings accounts",
    keywords: ["savings", "épargne", "livret", "livret a", "rate", "taux", "interest", "intérêts", "open", "ouvrir"],
    content:
      "Livret A: 2.4% annual rate, tax-free, maximum deposit 22,950 EUR. " +
      "Atlas Savings account: 2.0% annual rate, no ceiling. " +
      "Either account can be opened in the mobile app in a few minutes. Interest is calculated every 15 days and paid yearly.",
  },
  {
    id: "kb_disputes",
    title: "Disputing a transaction",
    keywords: ["dispute", "contester", "contestation", "unknown", "inconnu", "fraud", "fraude", "refund", "remboursement", "unauthorized"],
    content:
      "A client who doesn't recognize a card payment can dispute it within 13 months. " +
      "Disputes are handled by an advisor, who will ask for a signed statement. Suspected fraud should also lead to blocking the card. " +
      "Refunds for unauthorized payments are made within 1 business day once the dispute is filed.",
  },
];

/**
 * Deliberately naive keyword scoring.
 *
 * WHY not embeddings / a vector store? For seven articles it would be complexity with no benefit,
 * and the agent is good at reformulating queries: if the first search misses, it can try again
 * with other words (the tool description encourages that). The function signature is what the
 * tool depends on, so swapping in a real search engine later is a local change.
 */
export function searchKnowledgeBase(query: string, maxResults = 3): KnowledgeArticle[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2);

  return KNOWLEDGE_BASE.map((article) => {
    const haystack = `${article.title} ${article.content}`.toLowerCase();
    const score = terms.reduce(
      (acc, term) => acc + (article.keywords.includes(term) ? 3 : 0) + (haystack.includes(term) ? 1 : 0),
      0,
    );
    return { article, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ article }) => article);
}
