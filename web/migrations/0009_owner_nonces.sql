-- Single-use owner link nonces. D1 rather than KV: KV reads are not read-your-writes across
-- colos, so a get-then-burn there can be redeemed twice. INSERT ... ON CONFLICT DO NOTHING and
-- meta.changes === 1 is the burn. exp is Unix seconds.
CREATE TABLE owner_nonces (
  nonce TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
CREATE INDEX owner_nonces_exp ON owner_nonces (exp);
