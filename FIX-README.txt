Fix — "Invalid listing type" on domain publish
=================================================
Cause: app/api/listings/_handler.js has a server-side allowlist,
LISTING_TYPES, that the client never touches. It still only listed
['website', 'app', 'game', '3d', 'template'] — "domain" was added
to the ListingType union (lib/listings.ts) and to the client form
(DomainListingFormV2/SellDomainClient), but never to this list. So
every domain listing hit handleCreate's `if (!LISTING_TYPES.includes(type))`
check and got rejected with exactly the "Invalid listing type"
error shown on Publish.

This is the exact gap the original patch README flagged as "still
needed... no backend in scope."

File: app/api/listings/_handler.js
Overwrite at that exact repo-root path.

Changes:
  1. LISTING_TYPES (line 386) — added 'domain'.
  2. FEED_TYPES (line ~2789) — same gap, would have silently kept
     published domain listings out of the browse feed even after
     fix #1. Added 'domain'.
  3. handleCreate — now destructures domainName, domainInfo,
     domainOwnershipVerified from the request body, requires
     domainOwnershipVerified === true server-side before publishing
     (the client-side DNS TXT check is a UX gate only, per the
     original README's warning — this re-checks the flag rather than
     re-running the DNS lookup itself; a full independent re-check
     would additionally port the DNS TXT lookup from
     lib/domainLookup.ts into this handler), and stores domainName +
     a sanitized domainInfo on the created listing.
  4. handleUpdate — same domainName/domainInfo support added for
     editing an existing published domain listing (title/price edits
     already worked; only these two fields were previously dropped).
     domainOwnershipVerified is intentionally NOT editable here — it's
     only ever set at create time via the check in #3.

Not changed: components/profile/ManageListingsPage.tsx's separate
TypeFilter union still doesn't include "domain" — unrelated to this
bug, flagged as a feature choice in the original v2 fix.
