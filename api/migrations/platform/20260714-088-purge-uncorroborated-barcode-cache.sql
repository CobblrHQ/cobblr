-- Purge web-search guesses from the SHARED, cross-workspace barcode cache.
--
-- The shared cache is the Barcode Intelligence DB: whatever is in it becomes the
-- answer for the NEXT WORKSPACE that scans a given UPC. Until now, an
-- uncorroborated DuckDuckGo guess was promoted straight into it — so one bad scan
-- in one workspace silently became every workspace's answer, with a 30-day TTL.
--
-- It is not a hypothetical. A bare 12-digit UPC reads as a PHONE NUMBER to a
-- search engine, so a barcode with no product page reliably surfaces phone-
-- directory SEO. A pack of Harbor Freight silicone ties resolved to
-- "411 - White Pages | Find Phone Numbers", and that was one write away from being
-- the canonical name of that product for everyone on the instance.
--
-- The code now refuses to share an uncorroborated name (see
-- barcode-websearch.ts `corroborated`). This clears what the old code already put
-- there.
--
-- WHY ALL web-search rows, not just the bad ones: the existing rows carry no
-- record of whether anything corroborated them — that flag did not exist when they
-- were written. We cannot tell a good web-search resolution from a phone directory
-- after the fact, and guessing wrong in the "keep" direction leaves poison in a
-- shared store. So: drop them all. They are a CACHE. The next scan of any affected
-- code re-resolves it, this time only sharing the result if something actually
-- backs it up. Real catalog hits (go-upc, OpenFoodFacts, Open Library, MusicBrainz)
-- are untouched — they were never the problem.
--
-- manual recovery if this fails partway: nothing to recover. It is a cache; a
-- partial delete simply means fewer stale rows. Re-running is safe.

delete from shared_cache
 where namespace = 'barcode'
   and value ->> 'source' = 'web-search';
