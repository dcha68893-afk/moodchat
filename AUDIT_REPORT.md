# MoodChat Marketplace — Audit Report

All fixes were made **in the existing files** (no new files, no patches) after tracing the
actual request path frontend → route → controller → DB model. Every bug listed below was
confirmed by reading the real code paths, not assumed.

## Files changed
- `src/routes/tools.js`
- `src/routes/marketplace.routes.js`
- `src/routes/payments.js`
- `src/controllers/marketplace.controller.js`

---

## CRITICAL — Checkout was completely broken
**File:** `marketplace.controller.js`, `createOrder()`
`idempotency_key` was read 3 times but never destructured from `req.body`. Every real
checkout call threw an uncaught `ReferenceError`, meaning **no order could ever be placed**
through the normal buyer flow. Fixed by adding it to the destructure. Also hardened the
idempotency lookup, which previously used `findOne({where:{buyerId}})` with no ordering or
metadata filter — it could match an unrelated past order and silently fail to catch a real
duplicate. Now queries the JSONB `metadata.idempotency_key` field directly.

## HIGH — Add-to-cart was completely broken
**File:** `marketplace.controller.js`, `addToCart()`
The only real caller (`marketplace-ecommerce.js`) sends a batch `{ items: [...] }` body, but
the controller only ever read flat `product_id`/`price`/etc. fields directly off `req.body`.
Every real "add to cart" request 400'd with `product_id required`. Fixed to handle the batch
shape (replacing cart contents with the synced local state, avoiding quantity compounding on
repeated debounced syncs) while still supporting a single flat item for compatibility.

## HIGH — Real buyer flow was silently hijacked by a legacy system
**File:** `routes/tools.js`
`Tool-core.js` rewrites every `/api/marketplace/*` frontend call to `/api/tools/marketplace/*`.
`tools.js` had leftover alias routes at those exact paths pointing to the *old* Tools-listings
controller (a different, older marketplace system), registered *before* the real e-commerce
router mount. Product browsing, wishlist, recommendations, and order placement/cancel were
being served by the wrong data model. Removed the colliding aliases; the real e-commerce
router (already mounted at the bottom of the same file) now handles these paths correctly.

## HIGH — Fake payment success responses
**File:** `routes/payments.js`
`POST /api/payments/card` and `/api/payments/wallet` always returned `{success:true}` without
charging or debiting anything — a hardcoded fake success, which the checkout UI already
disables ("coming soon") but was still reachable directly. The real, fully-built
implementations already existed unused in `marketplace.controller.js` (real Flutterwave card
charge with an honest 503 when unconfigured; row-locked wallet DB debit with transaction
logging) — they just weren't wired to this file. Wired them in; no new payment logic was
written, it already existed.

## MEDIUM — Seller profile/dashboard/earnings 404s
**File:** `routes/marketplace.routes.js`
Frontend calls `/sellers/:id`, `/sellers/:id/dashboard`, `/sellers/:id/earnings` (plural);
only the singular `/seller/:id` route existed. Added the missing plural routes, reusing the
existing controller methods (dashboard/earnings already read the authenticated user from
`req.user`, so results are always the caller's own data).

## MEDIUM — Admin seller ban/verify buttons were 404ing
**File:** `routes/marketplace.routes.js`
- "Ban seller" posts to `/admin/sellers/:id/ban`; only `/admin/ban/:userId` existed. Added
  the matching route.
- "Verify/Reject seller" posts a single `{approved, reason}` body to
  `/admin/sellers/:id/verify`; only separate KYC approve/reject endpoints existed. Added a
  small dispatch route that calls the correct existing controller method based on the flag.

## MEDIUM — Stock quantity silently discarded on listing creation
**File:** `marketplace.controller.js`, `createProduct()`
The seller "create listing" form sends `stock_quantity`; the controller only ever read
`stock`. Every physical product created through the seller UI was saved with `stock: null`
(no inventory tracking) regardless of what the seller entered. Fixed to accept
`stock_quantity` (falling back to `stock` for compatibility).

---

## Confirmed but not fixed — needs real backend logic, not just routing
These have no matching route *and* no matching controller method. I did not add fake stub
routes for these — building them means writing real DB-backed logic:
- Admin audit log
- Admin coupon toggle (active/inactive)
- Admin buyer suspend / credit-wallet
- Admin product suspend (approve/reject/delete exist; suspend doesn't)
- Admin review hide (delete exists; hide/soft-hide doesn't)
- Admin return processing (refund approve/reject exist; a distinct "process return" flow doesn't)
- Admin ticket resolve (reply/close exist; resolve doesn't)

## Confirmed, working, but architecturally stale (not urgent — currently functions correctly)
- **Wishlist** runs off a legacy `Tool.savedBy` integer-array column. A dedicated `Wishlist`
  table already exists in the schema (with price-drop-notification fields) but is completely
  unused. The current array-based approach works (the earlier UUID/INTEGER type mismatch was
  already fixed in a prior session) but doesn't support the price-drop feature the dedicated
  table was built for.
- **Product image upload on listing creation**: the seller form reads images as base64 via
  `FileReader` and sends them inline in the create-listing payload, even though a dedicated
  `POST /products/:id/image` upload endpoint exists. Functions, but embeds large base64
  blobs directly in the product row instead of using the upload endpoint.

---

# Round 2 — remaining features inspected

## CRITICAL — Approved products were permanently invisible to buyers
**File:** `marketplace.controller.js`, `adminApproveProduct()` / `adminRejectProduct()`
`createProduct()` sets `available: false` at creation. Nothing anywhere in the codebase ever
flipped it to `true` on approval — `adminApproveProduct` only updated `status`/`approvalStatus`.
Every buyer-facing query (`getProducts`, search, trending, flash sales, recommendations) hard-
filters on `available: true`. Net effect: **no product a seller ever listed could become
visible to buyers, even after admin approval**, unless something else in the codebase happened
to flip that flag (nothing did). This is likely the single highest-impact bug in the whole
audit — it explains why the catalog would have appeared permanently empty in production. Fixed
by setting `available: true` on approval and explicitly `false` on rejection.

## MEDIUM — Search silently bypassed the approval-status visibility filter
**File:** `marketplace.controller.js`, `getProducts()`
The approval-status check and the search-term check both wrote to `where[Op.or]`; the search
condition silently overwrote the approval check whenever a `search` query param was present.
Combined both with `Op.and` instead of one clobbering the other.

## MEDIUM — Review "verified purchase" badge was wrong for multi-item orders
**File:** `marketplace.controller.js`, `createReview()`
The verified-purchase check used `metadata: { [Op.contains]: [...] }` to look inside an order's
item list — but `metadata` is a JSONB *object*, not an array, so Postgres JSONB containment
between mismatched types always returns false (silently swallowed by a `.catch()`). Combined
with `createOrder` only storing the *first* item's product_id as the order's top-level
`productId`, any order containing multiple distinct products from one seller could only ever
mark the first product's review as verified — every other genuinely-purchased item in that
order always showed as an unverified review. Rewrote the check to look inside the actual
`metadata.items` array in application code.

## MEDIUM — "Compare Products" had no backend at all
**File:** `marketplace.controller.js` / `routes/marketplace.routes.js`
Frontend already called `GET /marketplace/compare?ids=...` with a graceful client-only
fallback, but there was no route and no controller method — real prices/specs were never
server-verified. Added a real `compareProducts()` method (fetches the requested products,
builds a genuine spec comparison table: price, category, condition, brand, rating, stock,
delivery fee) and wired the route.

## MEDIUM — Address book delete / set-default silently 404'd
**File:** `marketplace.controller.js` / `routes/marketplace.routes.js`
Frontend already had working "delete address" and "set default address" buttons calling
`DELETE /addresses/:id` and `PATCH /addresses/:id/default`; neither method nor route existed.
Added both, using the same `Users.metadata.addresses` storage pattern as the existing
`getAddresses`/`saveAddress`.

## Verified correct, no bug found
- Coupon validation (`validateCoupon` + checkout's call site) — field names match, logic sound.
- Flash sales listing, seller inventory bulk update, seller analytics, shipping status update —
  all correctly wired and internally consistent.
- Admin flash-sale creation, admin refunds/returns listing — exist under slightly different
  method names than the route paths suggest, but correctly wired.

---

# Round 3 — loyalty, referral, KYC dispatch bug, refunds, subscription

## Correction to Round 1
Admin audit log is **not** missing — I mis-searched for `adminGetAuditLog`; the real method
is `getAuditLog` and it was already correctly wired at `GET /admin/audit-log`. Verified working.

## HIGH — Loyalty program was entirely non-functional
**File:** `marketplace.controller.js` — `getLoyalty()`, `redeemLoyalty()`, `updateOrderStatus()`
`loyaltyPoints` was read everywhere but **never credited anywhere** — every buyer's balance
was permanently stuck at 0. On top of that, `redeemLoyalty` didn't check the real balance or
deduct anything; it just echoed back a discount for whatever `points` number the client sent,
meaning any user could claim an arbitrary discount for points they never earned. Fixed:
- Orders now credit real loyalty points (1 point per KES 20 spent) once, when marked delivered.
- `redeemLoyalty` now checks the real balance, rejects if insufficient, deducts it, and returns
  a real redemption code logged to the audit log.
- `getLoyalty`'s `history` (previously hardcoded to always `[]`) now pulls real redemption
  events.

## MEDIUM — Refund approval never actually moved money
**File:** `marketplace.controller.js`, `adminApproveRefund()`
Approving a refund only flipped the DB status and restored stock — no money ever moved back
to the buyer regardless of payment method. Fixed the case fully within our control: wallet-paid
orders now get a real, transaction-locked wallet credit-back (same pattern as `walletPayment`).
For card/M-Pesa orders, the response is now honest that the gateway-side reversal still needs
to be processed manually through that gateway's dashboard — guessing at untested refund-API
call shapes against real payment gateways isn't something to do blindly with real money.

## Bug introduced and caught in this same session — now fixed
The `/admin/sellers/:id/verify` dispatch route added in Round 1 forwarded the seller's
**userId** to `adminApproveKYC`/`adminRejectKYC`, but those methods look up
`SellerProfile.findByPk(id)` expecting the **SellerProfile's own primary key**, not the userId.
Replaced with a dedicated `verifySeller()` controller method that looks the profile up by
`userId` correctly.

## Verified correct, no bug found
- KYC submission/approval/rejection (aside from the dispatch-route bug above, now fixed).
- Subscription upgrade — intentionally returns `pending_payment` / "contact support," which is
  the honest behavior (no fake success), not a bug.

---

# Round 4 — UI click-handler audit (frontend)

**Important caveat on method:** I don't have a running instance of this app with a browser —
I can't literally click through it and watch things render. What I did instead: extracted
every `onclick="window.X(...)"` handler across the marketplace frontend files (76 unique
references) and every `window.X = ...` definition across the whole codebase (671), then
checked each handler resolves to something real. This catches "the button calls a function
that doesn't exist" bugs reliably. It does **not** catch CSS/layout issues, responsive-breakpoint
problems, or animation glitches — I have no way to visually confirm those without a live
browser session.

## CRITICAL — Add to Cart did nothing, on every product view
**File:** `marketplace-ui-fix.js`
`window._jmAddToCart` and `window._jmBuyNow` were called by the product-detail page's buttons
but **never defined anywhere in the entire codebase**. Worse: the "real" renderer these buttons
were supposed to be a fallback for — `window.renderers.viewListingDetail` — is also never
defined anywhere, which means `_renderProductFallback` (the one with the broken buttons) is
not a rare fallback path, it's the *only* path that ever actually renders a product detail
page. Net effect: **the Add to Cart button was a permanent silent no-op on every single
product page**, in the actual code path real users hit. "Buy Now" happened to still work by
accident, because its onclick had a `|| window._jmNavMore?.('checkout')` fallback that fired
when the undefined function call evaluated to `undefined` — so it navigated to checkout, just
without ever adding the product to the cart first.

Fixed by defining both functions for real, wired to the actual `CartEngine.add()` that already
existed and works (confirmed in earlier rounds). Product data is cached by id when the detail
page renders, so these functions can look it up without needing a second network call.

## Swept for the same failure pattern elsewhere — clean
Checked every other cross-file method reference of this shape (`.getStore()`, `.openModal()`,
`.showToast()`, etc.) — all either have a real implementation or are guarded with
`typeof x === 'function'` checks with a working fallback, unlike the Add to Cart case which had
no fallback at all. No other dead buttons found via this method.

---

# Round 5 — "Seller Dashboard shows nothing" (and ~23 other menu items)

This is very likely the single biggest UI-functionality bug in the app, and it explains
exactly the symptom reported: clicking Seller Dashboard, My Listings, Inventory, Orders &
Shipping, Payouts, Analytics, Returns, Verification, every admin-* screen, and even
Wallet/Loyalty Points/Refer & Earn all rendered nothing.

## CRITICAL — Script-loading order silently destroyed ~23 menu items
**File:** `Tools.html` (root cause) / **Fix applied in:** `marketplace-ui-fix.js`

`Tool-core.js` and `Tool-ui.js` are loaded as `<script type="module">`. Browsers **always**
defer module scripts to run after HTML parsing completes, regardless of where they sit in the
document — so even though they're declared near the top of `Tools.html`, they actually execute
*after* every classic `<script src="marketplace-*.js">` tag further down the page.

Those classic scripts build a correct chain: `marketplace-advanced.js` wraps
`window._jmNavMore` to handle `wallet`/`loyalty`/`referral`, falling back to whatever came
before it for anything else; `marketplace-seller.js` wraps it again to handle all `seller-*`
pages plus `admin-approval`, falling back further; `marketplace-admin.js` wraps it once more
for the rest of `admin-*`. By the time `admin.js` finishes, that chain correctly covers all 23
of those pages.

Then `Tool-ui.js`'s deferred module code runs and does `window._jmNavMore = _navMore`
**unconditionally** — silently discarding that entire chain. Its own page-rendering switch
statement has explicit empty `break` cases for every `seller-*`/`admin-*` key (the code comment
there literally reads *"handled by marketplace-seller.js `_jmNavMore` override"* — the exact
override that had just been destroyed) and no case at all for `wallet`/`loyalty`/`referral`.
Every one of those clicks silently did nothing — no error, no console warning, just a menu
that closes and nothing happens, exactly as reported.

**The rendering code itself was never broken** — `renderPayouts`, `renderShipping`,
`renderReturns`, `renderVerification`, `renderSubscription`, the admin pages, the wallet/
loyalty/referral pages all exist and work. They were just permanently unreachable.

**Fix:** `marketplace-ui-fix.js` (which already runs last, after every other classic script,
specifically to fight exactly this class of race — it says so in its own header comment)
now captures the correctly-assembled chain the instant it loads, then — after giving
`Tool-ui.js`'s deferred module a moment to finish clobbering things — recomposes a final
`window._jmNavMore` that routes all 23 known seller/admin/wallet/loyalty/referral keys to the
real chain, and everything else to Tool-ui's own base handling (home, cart, wishlist, account,
etc. — which does work correctly on its own). Uses the same delayed-retry pattern
(`DOMContentLoaded` + `window.load` + staggered timeouts) already proven in this file for the
Add to Cart fix.

**Proper long-term fix, not done here:** the real solution is to stop loading `Tool-core.js`/
`Tool-ui.js` as ES modules in `Tools.html`, or to move the classic marketplace-*.js scripts so
they load strictly after Tool-ui's module code (e.g. via a `type="module"` import chain, or by
adding `defer` semantics consistently). I didn't restructure the entire script-loading strategy
of `Tools.html` in this pass — that's a bigger, riskier change than patching the symptom in the
one file already dedicated to this kind of fix. Flagging it as the real underlying issue.

---

# Round 6 — direct answers: chat routing and category visibility after approval

## Question: does buyer↔seller chat go through admin first?
**Traced the code — no.** It's designed as direct 1:1 chat between buyer and seller, no admin
moderation step exists anywhere in the backend for it. But tracing further surfaced a real bug:

### CRITICAL — The real product detail page had no way to message the seller at all
The working "Message Seller" button (`openChat(sellerId, name)`) only exists on the *old*
Tools-listings detail view. The real e-commerce product detail page (`_renderProductFallback`
— confirmed in Round 4 to be the only page that ever actually renders) had **no seller-contact
button whatsoever**. Separately, `Tool-core.js` has its own `contactSeller()` method that sends
a `CONTACT_SELLER` WebSocket event — but there is no backend handler for that event anywhere;
it's a message sent into the void. Fixed by adding a real "Message Seller" button to the
product detail page, wired through `chat.html`'s existing (and already fully working)
"Chat-seller bridge," which forwards to the messages iframe via `OPEN_CHAT_WITH_USER` — same
mechanism already used elsewhere in the app, not something newly built from scratch.

### Note on WhatsApp
The WhatsApp button in the app (`_jmOpenWhatsApp`) is a **hardcoded link to a fixed platform
support number**, not a per-seller contact — clicking it always messages the same number
regardless of which seller/product you're viewing. This isn't a bug, it's just not what it
might look like — there's no per-seller WhatsApp integration. `SellerProfile.phone` exists in
the schema and could support one, but I didn't build it: exposing a seller's raw phone number
to any buyer is a privacy/product decision, not a pure bug fix, so flagging rather than
silently doing it.

## Question: does an approved listing actually appear in categories, to all users?
**Now yes for the fix already made (Round 2), but found one more real gap.** The Round 2 fix
(setting `available: true` on approval) is necessary and is what makes a product visible to
`getProducts` at all — confirmed the category filter itself (`where.category = category`) was
always correct and needs no further fix. But:

### MEDIUM — Two seller category choices were unreachable by browsing
**File:** `marketplace.controller.js`, `getCategories()`
The seller create-listing form (`Tools.html`) lets sellers pick `furniture` ("Furniture &
Home") and `construction` ("Building & Construction") as a product's category — but neither
value existed in the backend's category list, which is what the buyer-facing Categories page
is built from. A product saved with either of those categories would pass approval and become
generally available, but have **no category tile a buyer could click to find it** — it would
only surface via the general feed/search, never via category browsing. Added both to the
category list so what sellers can actually select matches what buyers can actually browse into.



## Confirmed real gap, needs a change outside marketplace files (flagging, not touching)
**Referral program is fully static** (`getReferral` always returns `referrals: 0, earned: 0`).
There is no `referredBy`/`referral_code` field anywhere in the schema, and the signup flow
(`authController.js`) never captures a `?ref=CODE` parameter. Building this for real means
editing the registration flow in a separate, more sensitive file — I didn't want to make a
rushed edit to auth/signup in the same pass as payment logic. Real fix path: capture the ref
code at signup into `user.metadata.referred_by`, then compute real counts/earnings from that
in `getReferral` instead of hardcoding zeros.




---

# Round 7 — Vouchers, Inbox, Follow Sellers, and a critical cross-cutting bug

## CRITICAL — Users.metadata doesn't exist; every feature using it was silently no-op'ing
**File:** `marketplace.controller.js` (multiple methods)
While building the Follow Sellers fix below, found that the `Users` model has **no `metadata`
column at all** — the real JSONB field on that model is called `settings`. Sequelize silently
ignores unknown fields passed to `.update()` (no error, nothing written), so every method
reading/writing `user.metadata` was **silently failing** this entire time:
- `getAddresses`/`saveAddress`/`deleteAddress`/`setDefaultAddress` (pre-existing code, not
  something I wrote — the address book has likely never actually persisted anything, ever).
- `upgradeSubscription`'s plan check.
- `getLoyalty`/`redeemLoyalty`'s `metadata.loyalty_points` fallback path.
- My own just-written `toggleFollowSeller`/`getFollowedSellers` (round 7, below) — caught
  before it shipped.

Fixed all of them to read/write `user.settings` instead. Also fixed a raw SQL follower-count
query that referenced the same wrong column name and would have thrown "column metadata does
not exist" on every follow/unfollow. Swept the rest of the file for the same pattern under any
other variable name — clean; every other `.metadata` usage is on `Order`/`Refund`/`Tool`
instances, which genuinely do have that column.

## MEDIUM — Vouchers page was 100% hardcoded
**File:** `Tool-ui.js`, `_renderVouchers()`
Always showed "You currently have no available Vouchers" regardless of reality — zero fetch
call, even though a real, working `GET /marketplace/coupons` endpoint (`getPublicCoupons`)
already existed and worked. Now fetches and displays real active coupons with a copy-code
button, falling back to the empty state only when there genuinely are none.

## MEDIUM — Inbox page was 100% hardcoded
**File:** `Tool-ui.js`, `_renderInbox()`
Always showed "You don't have any messages" — zero fetch, even though a real, separate
notifications system (`notificationController.js`, `GET /api/notifications`) already existed
in the codebase. Now fetches and displays real notifications.

## MEDIUM — Follow Seller was fully fake, including the displayed stats
**File:** `Tool-ui.js` + new backend support in `marketplace.controller.js`/`marketplace.routes.js`
The "Follow" button only toggled a CSS class client-side — no persistence, reset on every
refresh. Worse: the follower count and "seller score" shown for suggested sellers were
`Math.random()`-generated fake numbers presented as real stats. There was no backend support
for following at all. Built real support: `POST /marketplace/sellers/:id/follow` (persisted via
`Users.settings.following`, same JSON-column pattern as addresses) and
`GET /marketplace/me/following`, with a real follower count computed from an actual DB query
instead of a random number. The frontend no longer shows a fake score for sellers the user
doesn't follow — it shows nothing rather than making something up, until real per-seller trust
scores are wired through consistently.


---

# Round 8 — order status HTTP-method bug, and the "empty client cache" pattern again

## MEDIUM — Order status update used the wrong HTTP verb
**File:** `marketplace-ecommerce.js`, `OrderEngine.updateStatus()`
Called `PUT /marketplace/orders/:id/status`; the backend only ever registered `PATCH` for that
path, so this call always 404'd. Checked the actual impact before assuming the worst: all three
payment paths (M-Pesa via its server-to-server callback, `cardPayment`, `walletPayment`)
already mark the order `paid` correctly through their own real, independent logic — so orders
were never actually stuck unpaid. The real, visible impact: right after a successful payment,
the buyer's own local order cache/UI never got the update (the local-state code only runs
inside the `if (resp?.success)` branch, which never fires on a 404), so the screen could still
show "pending" until the next full refetch. Fixed the verb to `PATCH`.

## The "renders from an empty/incomplete client cache instead of fetching real data" pattern, found 2 more times
Same root issue as the Vouchers/Inbox fixes in Round 7 — a page reads from a client-side cache
that's only populated as a side effect of visiting some *other* screen first, and both of these
are reachable directly from the top-level menu:

- **My Reviews** (`_renderReviewsPage`) read only `OrderEngine.getLocalOrders()` — empty unless
  "My Orders" happened to be opened earlier in the session. A buyer with real delivered orders
  could see "No orders to review yet" simply from opening this page first. Now fetches real
  orders before rendering.
- **My Analytics** (`_renderAnalyticsPage`, the quick account-level view — not the full Seller
  Analytics tool) filtered the generic product-browsing feed cache for "my" listings — a cache
  that's paginated/partial and can be totally empty if the seller never happened to browse
  products this session. An active seller with real sales could see "No seller data yet." Now
  calls the real, already-existing `GET /marketplace/seller/products` endpoint instead.


---

# Round 9 — Seller Dashboard, Inventory, Payouts, Shipping: response-shape mismatches

Went through the actual seller-tool screens from your screenshot one at a time. Now that the
navigation bug (Round 5) lets these pages render at all, this round found that several of them
render but show wrong/empty data because the backend response shape doesn't match what the
(well-built, already-existing) frontend code reads. Same root cause each time: a backend method
computes the right data but returns it under different key names than the frontend expects.

## HIGH — Seller Dashboard: 3 of 4 KPI cards and the entire Recent Orders list always blank
**File:** `marketplace.controller.js`, `getSellerDashboard()` / `getSellerAnalytics()`
The dashboard reads `d.recentOrders`, `rev.total`, `ords.total/pending`,
`prods.approved/pending/total_views`, and `an.conversion_rate` — none of which existed in the
real response (`getSellerDashboard` never returned `recentOrders` at all; `getSellerAnalytics`
returned `revenue`/`orders`/`products` as plain numbers, not the nested objects with those
sub-fields). Even after fixing the navigation bug, this page would have loaded but shown
Revenue/Live Products/Pending Orders/Conversion as blank or 0, and "no orders yet" regardless of
real activity. Restructured both endpoints to the nested shape the frontend actually reads, and
added the missing `recentOrders` array.

## HIGH — Seller Analytics (full page): same pattern, more missing fields
**File:** `marketplace.controller.js`, `getSellerAnalytics()`
The full Analytics tool also needed `orders.completed/cancelled`, `products.total_sold`, and a
`top_products` array (title/views/sold/revenue per product) — none of which existed either.
Included in the same rewrite above.

## HIGH — Inventory page always showed "No products yet"
**File:** `marketplace.controller.js`, `getSellerInventory()`
Returned a single flat `inventory` array; the frontend destructures `{items, low_stock,
out_of_stock}` — three names that never matched, so all three silently defaulted to empty
arrays regardless of real stock data. The low-stock/out-of-stock warning banners never showed
either. Fixed to return the three groups the UI actually branches on.

## HIGH — Payouts page: every number always showed 0, history always empty
**File:** `marketplace.controller.js`, `getPayouts()`
Returned `{payouts, available_balance, commission_rate}`; the frontend reads `available`,
`pending_payout`, `total_earned`, `gross_sales`, `platform_fee`, `total_withdrawn`, and
`payout_history` — none of which matched. The entire Payouts screen (hero balance figure,
gross sales, platform fee, net earnings, total withdrawn, and the whole payout history list)
always rendered as zero/empty despite the real underlying computation being correct.

## MEDIUM — Seller's M-Pesa number silently dropped on every payout request
**File:** `marketplace.controller.js`, `requestPayout()`
The payout request modal sends the phone number as `account`; the backend only ever read
`phone`. Every payout request got created with no recipient number recorded, so processing it
would require manually tracking the seller down for their number. Now accepts either field name.

## MEDIUM — Buyer's "Track Order" never showed the seller's tracking number
**File:** `marketplace.controller.js`, `updateShipping()` / `getOrderTracking()`
When a seller marks an order shipped and enters a tracking number, that data was only ever
written into `order.metadata` — but the buyer-facing tracking endpoint reads the real top-level
`trackingNumber`/`shippedAt`/`deliveredAt` columns, which were never touched. Every shipped
order showed a blank tracking number and no shipped/delivered dates to the buyer, regardless of
what the seller entered. Fixed to write to the real columns the buyer's view actually reads.

## MEDIUM — "Print Label" button had no backend at all
**File:** `marketplace.controller.js` / `marketplace.routes.js`
`GET /marketplace/seller/orders/:id/shipping-label` had no route or controller method — the
button always showed "Label not available yet" regardless of real order data. Built a real one
using the order's actual delivery address, tracking number, and items.


---

# Round 10 — Returns, Verification, Subscription (finishing the seller-tools sweep)

## HIGH — Seller's return-approval never actually refunded the buyer
**File:** `marketplace.controller.js`, `approveReturn()`
This was a **separate, duplicate implementation** from `adminApproveRefund` (fixed in Round 3)
that only flipped a status flag — no money ever moved back to the buyer when a *seller*
approved a return (as opposed to an admin). Rewrote it to reuse the same real logic: wallet-paid
orders get a real, transaction-locked credit-back; card/M-Pesa orders honestly report that the
gateway-side refund still needs manual processing, instead of silently claiming it's done.

## MEDIUM — Return requests showed blank order number, date, and amount
**File:** `marketplace.controller.js`, `getSellerReturns()`
Returned raw `Refund` rows with camelCase fields (`orderId`, `createdAt`, `amount`); the
frontend reads snake_case (`order_id`, `requested_at`, `total`). Every return request row in the
seller's Returns page showed a blank order number, blank date, and blank amount — only `reason`
and `status` happened to line up. Fixed to map to the field names the frontend actually reads.

## MEDIUM — Sellers under KYC review saw the wrong message
**File:** `marketplace.controller.js`, `getKYCStatus()`
The database stores `pending_review`, but the frontend's status-message map only has a
`pending` key — so a seller who had genuinely already submitted KYC and was waiting for review
saw "Submit KYC documents to get verified," the same message shown to someone who'd never
submitted anything. Real risk: confused duplicate submissions. Also, when a submission was
rejected, the actual reason an admin left was never returned — sellers always saw the generic
fallback text instead of why they were rejected. Fixed both.

## LOW — 3 more instances of the Round 7 Users.metadata bug, missed in the first sweep
**File:** `marketplace.controller.js` — `getSellerSubscription()`, `getLoyalty()`, `getAddresses()`
The Round 7 fix caught every direct `user.metadata` property access, but missed three places
where `'metadata'` appeared inside a Sequelize `attributes: [...]` array instead — a different
syntactic shape my search pattern didn't match. Since `metadata` isn't a real column, these
three queries were silently never fetching the real `settings` data at all, meaning seller plan
lookups, loyalty point reads, and address reads could all be affected depending on exact query
path. Did a proper grep sweep this time (`attributes:.*'metadata'`) and confirmed clean — the
only remaining `metadata` reference in the whole file is on `Order`, which genuinely has that
column.


---

# Round 11 — Admin Product Approval queue always showed empty

## CRITICAL — Admins could never see which products were waiting for approval
**File:** `marketplace.controller.js`, `adminGetPendingProducts()`
Returned the raw array directly as the response's `data` field (`ok(res, pending, ...)`), but
the frontend reads `r?.data?.products` — expecting `data` to be an *object* with a `products`
key, not the array itself. Since `data` was an array, `data.products` was always `undefined`,
so the admin's Product Approval screen always showed "All caught up! No products pending
review" — regardless of how many products were genuinely waiting.

This compounds directly with the Round 2 fix (a product only becomes visible to buyers once
admin-approved): if admins could never see the queue to approve anything, new listings could
get stuck invisible indefinitely with no way for anyone to notice or unblock them. Fixed the
response shape and switched to the same `_formatProduct` formatting used elsewhere for
consistent field names (the raw rows also didn't have a `submitted_at` field the frontend
checks for).

Swept the rest of the file for the same "bare array passed as `data`" pattern — this was the
only instance; the other three admin list endpoints (`adminGetOrders`, `adminGetSellers`,
`adminGetBuyers`) were already correctly wrapped.


---

# Round 12 — pages stacking on top of each other instead of replacing ("duplicate on screen"), reported directly

This was a real, precisely-located, distinct bug from everything found so far — traced from
your description, not guessed at.

## CRITICAL — Every seller-tool and admin-tool page stayed permanently stuck on screen
**Files:** `marketplace-seller.js`, `marketplace-admin.js`
The base CSS is correct: `.jm-page { display:none }`, `.jm-page.active { display:flex }` — so
switching pages should just be a matter of toggling the `.active` class. And the cleanup code
did exactly that: `document.querySelectorAll('.jm-page').forEach(p =>
p.classList.remove('active'))`.

The bug: right after creating each seller-tool or admin-tool page, both files also force an
**inline style directly onto that page's element** (`el.style.cssText =
'display:flex!important;...'` in `marketplace-seller.js`, without `!important` but with the
same effect in `marketplace-admin.js`). Inline styles override external stylesheet rules
regardless of the CSS class — so removing `.active` from a page did nothing to actually hide it
once this inline override had been set. Every seller/admin page you'd ever opened stayed
visually stuck on screen forever, and every subsequent page you opened stacked on top of it
instead of replacing it — exactly the "click one feature, then another, and they display
together as duplicates" symptom you reported.

Fixed by clearing the full inline `style.cssText` (not just the class) on every `.jm-page`
before showing a new one, in both files — this restores proper CSS-class-based control, so only
the currently active page is ever visible.

**On "some pages have no back button":** checked — every seller-tool and admin-tool render
function does build a real back button (`_page()` and `_pageShell()` both include one). I
believe what you were seeing was a symptom of the stacking bug above, not a separate missing
button: with multiple pages piled on top of each other, an earlier page's back button could
easily end up buried under a later page's content, making it look absent. Should be resolved by
the same fix — but flagging this as inference rather than something I separately traced, in
case you still see a specific screen with no way back after this fix.


---

# Round 13 — Cart & Wishlist: never actually loaded from the server (real data-loss risk)

You specifically asked about cart and other buyer features — this was the most serious thing
found there, and it's a genuine data-loss risk, not just a display bug.

## CRITICAL — Cart only ever loaded from localStorage, never from the server
**File:** `marketplace-ecommerce.js`, `ProductEngine.init()` / `CartEngine.syncFromServer()`
A correctly-designed `CartEngine.syncFromServer()` function already existed in the codebase —
but it was **never called from anywhere**. `init()` only ever restored the cart from
`localStorage`. Practical effect: a buyer who added items on one device/browser, then opened
the marketplace on another device, or after clearing local storage, saw an **empty cart**
despite having a real, persisted cart on the server. Worse: the cart's own sync-to-server logic
does a full *replace* — so the moment that "empty-looking" buyer added anything new, it would
silently overwrite and wipe out their real saved cart items on the server. This is a genuine way
real customer data could get permanently lost, not just a cosmetic bug.

While fixing this, found two more bugs in the same function:
- It read `resp?.data?.items`, but the real `GET /cart` response nests items under
  `data.cart.items` — the wrong path meant it would have found nothing even once called.
- It assumed a nested `item.product` object on each cart item; the real Cart model stores flat
  fields (`title`, `price`, `image`) with no nested object at all — items would have hydrated
  with a bare ID and blank title/price/image.

Fixed all three and wired the corrected function into `init()`, so the server cart is now the
source of truth whenever it's reachable, exactly as the function's own (previously unused)
design intended.

## HIGH — Clearing your cart didn't tell the server
**File:** `marketplace-ecommerce.js`, `CartEngine._syncToServer()`
The sync-to-server call only fired when the cart had items (`if (items.length > 0)`) — so
emptying your cart locally never informed the server. Combined with the hydration fix above,
this would have caused a genuinely confusing bug: clear your cart, come back later (or on
another device), and the "removed" items reappear, because the server was never told they were
gone. Now sends a real clear request when the local cart becomes empty.

## MEDIUM — Wishlist had the identical bug, plus a second one
**File:** `marketplace-ecommerce.js`, `WishlistEngine.syncFromServer()`
Same missing-wiring problem as the cart — a real `syncFromServer()` existed, never called.
Additionally, even if it had been called, it only stored the product *ID*, not the product data
itself — and `getWishlist()` looks up full product details from a separate browse cache, so a
wishlisted product would show as empty/missing unless it happened to already be cached from
unrelated browsing (the same "renders from an incomplete client cache" pattern found repeatedly
in earlier rounds). The real endpoint already returns full product data per item — now storing
that directly instead of discarding it, and wired into `init()`.


---

# Round 14 — Checkout phantom orders, and product carousels across the whole app

## CRITICAL — A failed checkout was silently shown to the buyer as successful
**Files:** `marketplace-ecommerce.js` (`OrderEngine.checkout()`) and `marketplace-checkout.js`
(`_jmPlaceOrder()`) — two separate, duplicate checkout implementations, same bug in both.

When the real order-creation call failed for *any* reason — network unreachable, or the server
genuinely rejecting the order (out of stock, validation error, anything) — both implementations
fell back to creating a **fake local "order"** and reported `success: true`. There is no
reconciliation or retry mechanism anywhere in the codebase that ever turns these into real
orders — confirmed by search, not assumed. Practical effect: a buyer could see "Order placed
successfully!", have it appear in their order history, and genuinely believe they'd bought
something that was never actually created on the server, with no seller ever notified and no
real path to fulfillment. Fixed both to report an honest failure with a real error message
instead.

(Separately verified: `POST /marketplace/checkout` — the endpoint the real "Place Order" button
calls — does exist and correctly routes to the same real order-creation logic already fixed in
Round 1. I initially suspected it was calling a nonexistent endpoint and want to be upfront that
I was wrong before double-checking; it's real and working.)

## CRITICAL — Every product carousel in the app had a dead click handler
**File:** `Tool-ui.js`
Featured, Flash Sales, Trending, Recommendations, Recently Viewed, and every other horizontal
product row (`_renderHScroll` — used pervasively, including on the home page, the primary
product-discovery surface) called `renderers.viewListingDetail(p)` when clicked. That function
is real and exists — but it's built entirely for the old Tools-listings data shape
(`listing.user.displayName`, `listing.videoIntro`, a completely different detail panel). Called
with a real e-commerce product, it wouldn't crash — it would silently render the wrong, broken,
mostly-empty legacy panel instead of the real product page (with working Add to Cart, Message
Seller, etc. from earlier rounds). Fixed to open the real, working product page instead.

Swept every other call site of `viewListingDetail` in the file to check which ones are
legitimately serving the old Tools-listings system (correct as-is, no bug) versus which pass
real e-commerce products (buggy). Found one more genuine instance — a search-suggestions
dropdown — and fixed it the same way. The main product grid and "saved items" modal are
confirmed to be legacy-Tools-only data sources, so `viewListingDetail` is correctly matched
there; left those alone.


---

# Round 15 — My Orders fetch bug, and building out the product detail page

## HIGH — My Orders could show "no orders found" for buyers with real order history
**File:** `Tool-ui.js`, `_renderOrders()`
Same pattern as Reviews/Analytics from earlier rounds: only read from the local order cache,
never fetched from the server. My Orders is very plausibly the *first* page a buyer opens in a
session (e.g. checking status right after a notification) — if so, the cache is empty and a
buyer with real orders would see "No orders found." Fixed to fetch real orders first.

(Checked the order-detail click handler for the same load-order race found earlier in the
session — it turns out to be dead code that never actually resolves, but a `||` fallback to a
second, independently-working function saves it in practice. Confirmed working, left alone.)

## Built out the real product detail page: reviews and related products
**File:** `marketplace-ui-fix.js`
The real product detail page (confirmed in Round 4 to be the only one that ever actually
renders) had no reviews section and no related-products section at all, despite both having
real, working backend endpoints already — `GET /products/:id/reviews` (including the verified-
purchase badges fixed in Round 3) and `GET /recommendations`. This wasn't a bug to fix so much
as a real, buildable gap — a product page without reviews or related items is missing
core e-commerce functionality buyers expect. Built both using the existing, already-verified
endpoints.


## Not covered by this pass
Visual/CSS rendering, responsive layout, animation correctness — still can't see rendered
output directly. Screenshots like the one that led to the Round 5 fix are exactly how to keep
finding this class of bug — please keep sending them for anything else that looks wrong.
