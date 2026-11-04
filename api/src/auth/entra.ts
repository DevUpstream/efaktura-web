/** Microsoft Entra ID (OIDC, authorization code + PKCE, confidential client). */
import * as oidc from "openid-client";

export interface EntraClaims { oid: string; tid: string; email: string; name: string }

export interface OidcProvider {
  authUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  exchange(currentUrl: URL, check: { state: string; nonce: string; verifier: string }): Promise<EntraClaims>;
}

export function entraProvider(cfg: { tenantId: string; clientId: string; clientSecret: string }): OidcProvider {
  let conf: Promise<oidc.Configuration> | undefined;
  const config = () => (conf ??= oidc.discovery(
    new URL(`https://login.microsoftonline.com/${cfg.tenantId}/v2.0`), cfg.clientId, cfg.clientSecret,
  ).catch((e) => { conf = undefined; throw e; }));

  return {
    async authUrl({ redirectUri, state, nonce, codeChallenge }) {
      return oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri, scope: "openid profile email", response_type: "code",
        state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account",
      });
    },
    async exchange(currentUrl, { state, nonce, verifier }) {
      const tokens = await oidc.authorizationCodeGrant(await config(), currentUrl, {
        pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
      });
      const c = tokens.claims() as Record<string, unknown> | undefined;
      if (!c) throw new Error("Nema id_token");
      const email = String(c.email ?? c.preferred_username ?? "").toLowerCase();
      return { oid: String(c.oid ?? ""), tid: String(c.tid ?? ""), email, name: String(c.name ?? email) };
    },
  };
}

export const pkce = {
  verifier: () => oidc.randomPKCECodeVerifier(),
  challenge: (v: string) => oidc.calculatePKCECodeChallenge(v),
  state: () => oidc.randomState(),
  nonce: () => oidc.randomNonce(),
};
