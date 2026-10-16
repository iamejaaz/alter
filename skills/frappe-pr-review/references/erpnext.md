# ERPNext lens

Read this for any `frappe/erpnext` PR, on top of the rubric. ERPNext is an accounting and stock system first: a bug that posts a wrong number is worse than a crash, because nobody notices it until the books do not close.

## Ledgers are the source of truth
- GL Entry, Stock Ledger Entry and Payment Ledger Entry rows are written on submit and must not be edited afterwards. Corrections go through cancel and amend, or through reposting (Repost Item Valuation, Repost Accounting Ledger). A change that writes to these rows directly, or changes what gets posted, is high risk.
- For any change to what a document posts, check the whole round trip on the bench: submit (entries appear, debits equal credits), cancel (entries are reversed, nothing left behind), amend and submit again. Then check the General Ledger, Trial Balance, Stock Balance or Accounts Receivable/Payable report agrees with the entries.
- Back-dated entries: a stock or accounting entry dated before existing ones triggers reposting of everything after it. Ask what happens when the document is back-dated, not only when it is today's.

## Stock
- Valuation differs by method (FIFO, Moving Average, and batch-wise for batches). A change to rates or quantities must hold for each method the code path can see.
- Items come in kinds that take different paths: plain stock items, serial numbers, batches (Serial and Batch Bundle since v15), non-stock items, and product bundles. Check the PR against the kinds it can touch, not just the one in the description.
- Negative stock is a setting. Code that assumes stock is never negative, or always allowed, is a finding.

## Accounting
- Multi-currency: transaction fields and `base_` fields are in different currencies; exchange rates and exchange gain/loss must stay consistent. Multi-company: accounts, cost centers and defaults belong to one company; code that picks the first one it finds is wrong on a two-company site.
- Precision and rounding go through `flt(value, precision)` and the rounding adjustment / round-off account. Totals must still match after rounding.
- Taxes (including inclusive taxes), accounting dimensions (cost center, project and custom dimensions must reach the GL), deferred revenue and expense, fiscal year boundaries, and frozen periods (accounts frozen till a date, period closing) are the usual places a change silently skips.

## Document flows
- Documents map into each other (Quotation to Sales Order to Delivery Note to Sales Invoice; Purchase Order to Purchase Receipt to Purchase Invoice) through `get_mapped_doc` functions. A new field or rule on one document usually also needs the mapping and the next document. Returns and credit or debit notes (`is_return`) flip signs; check them.
- Billed and delivered percentages and the status they drive (`per_billed`, `per_delivered`, Completed, To Bill) must update on submit and on cancel, including partial flows.

## Shared controllers and siblings
- Transactions share base controllers (AccountsController, StockController, BuyingController, SellingController). A fix in one doctype often belongs in the shared controller, and a change to a shared controller reaches every transaction. Check the sibling doctypes: Sales Invoice and Purchase Invoice and POS Invoice, Delivery Note and Purchase Receipt, Sales Order and Purchase Order.

## Patches and performance
- Real ERPNext sites have very large GL Entry, Stock Ledger Entry and Item tables. A patch or query over them must work in batches or in SQL, use indexed columns, and be safe to run twice. Ask what it costs on a site with millions of ledger rows.

## Reproducing on the bench
- Use clearly fake fixtures with example names (a test company, items, warehouses, customers and suppliers), never real data.
- For an accounting or stock change, compare the ledger rows on develop and on the PR head for the same steps, and include the numbers in the finding.
- Stable branches differ: v14 has no Serial and Batch Bundle, so a backport touching serials or batches needs its own check.
