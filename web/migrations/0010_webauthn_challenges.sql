-- WebAuthn challenges are single-use too: a replayed challenge is a replayed signature.
-- kind is 'register' or 'login'; exp is Unix seconds.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  exp INTEGER NOT NULL
);
CREATE INDEX webauthn_challenges_challenge ON webauthn_challenges (challenge);
CREATE INDEX webauthn_challenges_exp ON webauthn_challenges (exp);
