/**
 * Every URL this site is asked for, in one place.
 *
 * The two PDF endpoints are the reason the download pipeline can run independently of the
 * detail pipeline: both are addressed by numeric ids that come from the listing and the detail
 * page, and neither needs the session-bound `ca` token. That is worth stating out loud because
 * it is what makes `--scale worker=N` meaningful for the slowest part of the crawl.
 */
export const BASE_URL = 'https://pjett.trf5.jus.br';
const APP = '/pjeconsulta';

export interface Trf5Urls {
  base: string;
  listView: string;
  detail: (ca: string) => string;
  /** The case cover sheet. One per case, addressed only by `idProcessoTrf`. */
  reportPdf: (idProcessoTrf: string) => string;
  /** The receipt for one attached document. Needs the `(idBin, idProcessoDoc)` pair. */
  receiptPdf: (idBin: string, idProcessoDoc: string, idProcessoTrf: string) => string;
}

export function trf5Urls(base: string = BASE_URL): Trf5Urls {
  const detailPath = `${APP}/ConsultaPublica/DetalheProcessoConsultaPublica`;
  return {
    base,
    listView: `${base}${APP}/ConsultaPublica/listView.seam`,
    detail: (ca) => `${base}${detailPath}/listView.seam?ca=${encodeURIComponent(ca)}`,
    reportPdf: (id) =>
      `${base}${detailPath}/reportPDF.seam?idProcessoTrf=${encodeURIComponent(id)}`,
    receiptPdf: (idBin, idProcessoDoc, idProcessoTrf) =>
      `${base}${APP}/Processo/reportReciboPDF.seam` +
      `?idBin=${encodeURIComponent(idBin)}` +
      `&idProcessoDoc=${encodeURIComponent(idProcessoDoc)}` +
      `&idProcessoTrf=${encodeURIComponent(idProcessoTrf)}`,
  };
}

/**
 * Where a failed detail request ends up. Both mean "this `ca` will not work", but they mean
 * different things about *why*, and the classifier needs to tell them apart: a redirect back to
 * the search page is a dead session and is worth renewing for, while `errorUnexpected` is a case
 * the site itself cannot render and retrying it just spends requests on a tribunal.
 */
export const SESSION_LOST_PATH = '/ConsultaPublica/listView.seam';
export const UNRENDERABLE_PATH = '/errorUnexpected.seam';
