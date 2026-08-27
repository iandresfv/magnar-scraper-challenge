/**
 * Cookie jar over `tough-cookie`.
 *
 * Why a real RFC 6265 jar rather than a `Map` of name to value: this site sets four cookies with
 * **different paths** — `JSESSIONID` and `trf501f66e06` on `/pjeconsulta`, `ROUTER_ID` and
 * `trf501ad1ee3` on `/`. Sending all four everywhere works by luck; sending them by path is
 * correct, and the F5's sticky routing depends on getting it right.
 *
 * The jar is per session and per worker, and it lives as long as the session does: the suffix on
 * `JSESSIONID` (`.tt-consulta-229-vj5x8`) names a cluster node, and losing it means losing the
 * Seam conversation.
 */
import { CookieJar as ToughJar } from 'tough-cookie';
import type { CookieJarPort } from '../../core/ports/http.js';

export class CookieJar implements CookieJarPort {
  private constructor(private readonly jar: ToughJar) {}

  static create(): CookieJar {
    return new CookieJar(new ToughJar());
  }

  /** Restores a jar previously produced by `serialize`, for handing a session between processes. */
  static async fromJson(json: string): Promise<CookieJar> {
    return new CookieJar(await ToughJar.deserialize(JSON.parse(json) as never));
  }

  async setFromResponse(url: string, setCookieHeaders: readonly string[]): Promise<void> {
    for (const header of setCookieHeaders) {
      // A malformed cookie must not abort a response that is otherwise fine; the site emits
      // `SameSite=None` without `Secure` on some paths, which older parsers reject outright.
      await this.jar.setCookie(header, url, { ignoreError: true });
    }
  }

  /**
   * The `Cookie` header for a URL, or `''` when the jar has nothing for it.
   *
   * The caller must **omit the header entirely** when this returns empty. Measured
   * (`docs/spike-fase0.md` §2): an empty `Cookie:` header makes the F5 answer `200 OK` with its
   * "Requisição - Rejeitada" page instead of the form. Not a 403 — a 200 with a plausible body,
   * which is the worst kind of failure.
   */
  async headerFor(url: string): Promise<string> {
    return this.jar.getCookieString(url);
  }

  async serialize(): Promise<string> {
    return JSON.stringify(await this.jar.serialize());
  }

  /** Cookie names currently held, for diagnostics. */
  async names(url: string): Promise<string[]> {
    return (await this.jar.getCookies(url)).map((c) => c.key);
  }
}
