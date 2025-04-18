// @ts-check
/*
 * Copyright © 2025 Calvin Walton
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the “Software”), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/**
 * @typedef {Object} RateControl
 * @property {number} delay
 * @property {number} exponent
 * @property {number} lastRequest
 */

/**
 * @typedef {Object} ISRCSubmissionData
 * @property {Array<{id: string, isrcs: Array<string>}>} recordings
 * @property {string} [editNote]
 */

const requestDelayMinimum = 1000; // ms
const rateControlStorage = 'mbFetchRateControl';
/** @type {RateControl} */
const rateControlDefault = {
  delay: requestDelayMinimum,
  exponent: 0,
  lastRequest: 0,
};
const xmlns = 'http://musicbrainz.org/ns/mmd-2.0#';

/**
 * @param {Response} response
 * @returns {boolean}
 */
function isRetriableFailure(response) {
  return (response.status === 429 || response.status >= 500);
}

/**
 * Generate an XML document for submitting ISRCs.
 *
 * @param {ISRCSubmissionData} data
 * @returns {XMLDocument}
 */
function generateSubmitISRCsXML(data) {
  const doc = document.implementation.createDocument(xmlns, null, null);
  const metadata = doc.createElementNS(xmlns,'metadata');
  doc.appendChild(metadata);
  const recordingList = doc.createElementNS(xmlns, 'recording-list');
  metadata.appendChild(recordingList);

  for (const recordingData of data.recordings) {
    if (!(recordingData.isrcs.length > 0)) { continue; }

    const recording = doc.createElementNS(xmlns, 'recording');
    recording.setAttribute("id", recordingData.id);
    recordingList.appendChild(recording);
    const isrcList = doc.createElementNS(xmlns, 'isrc-list');
    isrcList.setAttribute('count', ''+recordingData.isrcs.length);
    recording.appendChild(isrcList);

    for (const isrcData of recordingData.isrcs) {
      const isrc = doc.createElementNS(xmlns, 'isrc');
      isrc.setAttribute('id', isrcData);
      isrcList.appendChild(isrc);
    }
  }

  if (data.editNote) {
    const editNote = doc.createElementNS(xmlns, 'edit-note');
    editNote.textContent = data.editNote;
    metadata.appendChild(editNote);
  }

  return doc;
}

/**
 * Parse an XML document from text, handling the strange way that parse errors are reported.
 *
 * @param {string} text
 * @returns {XMLDocument}
 */
function parseXMLPostResponse(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');

  const firstChild = doc.firstElementChild;
  if (!firstChild) {
    throw new Error('XML response has no document element');
  }
  if (firstChild.nodeName == 'parseerror' && firstChild.namespaceURI == 'http://www.mozilla.org/newlayout/xml/parsererror.xml') {
    throw new Error(`${firstChild.textContent}`);
  }

  const messageResult = doc.evaluate('/metadata/message/text', doc, null, XPathResult.ANY_UNORDERED_NODE_TYPE, null);
  if (messageResult.singleNodeValue === null) {
    throw new Error(`XML response has unexpected format`);
  }
  const message = messageResult.singleNodeValue.textContent;
  if (message !== 'OK') {
    throw new Error(`Request failed with message: ${message}`);
  }

  return doc;
}

class MbFetch {
  /** @type {string | null} */
  #accessToken = null;
  /** @type {string} */
  #client;
  /** @type {URL} */
  #ws2Base;

  /** @type {any} */
  #cachedRelease = {};
  /** @type {DOMHighResTimeStamp} */
  #cachedReleaseTime = 0;

  /**
   * Create a new MbFetch instance for a given MusicBrainz API url.
   *
   * @param {URL} ws2Base
   * @param {string} client
   */
  constructor(ws2Base, client) {
    this.#ws2Base = ws2Base;
    this.#client = client;
  }

  /**
   * Set or update the accessToken required for authenticated requests.
   *
   * @param {string} accessToken
   */
  set accessToken(accessToken) {
    this.#accessToken = accessToken;
  }

  /**
   * Fetch current rate control status from local storage, or initialize if not present.
   *
   * @returns {RateControl}
   */
  #loadRateControl() {
    const storedRateControl = window.localStorage.getItem(rateControlStorage);
    if (storedRateControl !== null) {
      return Object.assign({}, rateControlDefault, JSON.parse(storedRateControl));
    } else {
      return Object.assign({}, rateControlDefault);
    }
  }

  /**
   * Save updated rate control to local storage.
   *
   * @param {RateControl} rateControl
   */
  #storeRateControl(rateControl) {
    window.localStorage.setItem(rateControlStorage, JSON.stringify(rateControl));
  }

  /**
   * Called before making an API request to throttle the request rate.
   */
  async #delayToNextRequest() {
    const rateControl = this.#loadRateControl();

    const elapsed = performance.now() - (rateControl.lastRequest - performance.timeOrigin);
    const delay = rateControl.delay - elapsed;
    if (delay > 0) {
      console.log(`MbFetch: last request was ${elapsed} ms ago, waiting ${delay} ms before starting another one`);
      await /** @type {Promise<void>} */ (new Promise((resolve) => { setTimeout(() => resolve(), delay)}));
    } else {
      console.log(`MbFetch: last request was ${elapsed} ms ago, starting another one`);
    }

    rateControl.lastRequest = performance.now() + performance.timeOrigin;
    this.#storeRateControl(rateControl);
  }

  /**
   * Called after making an API request to adjust the time between requests based on the response
   *
   * @param {boolean} slowDown
   */
  #adjustRateControl(slowDown) {
    const rateControl = this.#loadRateControl();

    if (slowDown) {
      const delay = Math.max(Math.pow(2, rateControl.exponent) * 1000, requestDelayMinimum);
      rateControl.exponent = Math.min(rateControl.exponent + 1, 5);
      console.log(`MbFetch: slow down; delay ${rateControl.delay} -> ${delay}`)
      rateControl.delay = delay;
    } else {
      const delay = Math.max(rateControl.delay / 2, requestDelayMinimum);
      rateControl.exponent = 0;
      console.log(`MbFetch: back off; delay ${rateControl.delay} -> ${delay}`)
      rateControl.delay = delay;
    }

    this.#storeRateControl(rateControl);
  }

  /**
   * Wrapper function to do rate control waiting and updates around a fetch call, with retries.
   *
   * @param {URL | Request} urlOrRequest
   * @param {number} [retries]
   * @returns {Promise<Response>}
   */
  async #fetchInternal(urlOrRequest, retries = 4) {
    await this.#delayToNextRequest();

    const request = new Request(urlOrRequest);
    const response = await window.fetch(request);
    const slowDown = isRetriableFailure(response);
    this.#adjustRateControl(slowDown);

    if (retries > 0 && slowDown) {
      console.log(`MbFetch: server reported status ${response.status}, ${retries} retries remaining`);
      return this.#fetchInternal(urlOrRequest, retries - 1);
    }

    if (response.status !== 200) {
      throw new Error(`MusicBrainz API request failed with status ${response.status} ${response.statusText}`);
    }

    return response;
  }

  /**
   * Wrapper function to make use of the Web Locks api when available to serialize requests between
   * multiple tabs.
   *
   * @param {URL | Request} urlOrRequest
   * @returns {Promise<Response>}
   */
  async #rateControlledFetch(urlOrRequest) {
    if (typeof(navigator.locks) !== "undefined") {
      return await navigator.locks.request(rateControlStorage, () => { return this.#fetchInternal(urlOrRequest); });
    } else {
      return await this.#fetchInternal(urlOrRequest);
    }
  }

  /**
   * Lookup a release by mbid. Note that the "inc" value is hardcoded for use by MagicISRC.
   *
   * @param {string} mbid
   * @returns {Promise<any>}
   */
  async lookupRelease(mbid) {
    if (this.#cachedRelease.id === mbid && (performance.now() - this.#cachedReleaseTime) < 300_000) {
      return this.#cachedRelease;
    }

    const url = new URL("release/" + mbid, this.#ws2Base);
    const params = url.searchParams;
    params.set('fmt', 'json');
    params.set('inc', 'artist-credits+isrcs+labels+recordings');
    const request = new Request(url, { headers: { 'Accept': 'application/json' } });

    const response = await this.#rateControlledFetch(request);
    const body = await response.json();
    if (body['error']) {
      throw new Error(`MusicBrainz release lookup returned error: ${body['error']}`);
    }

    this.#cachedRelease = body;
    this.#cachedReleaseTime = 300;
    return body;
  }

  /**
   * Submit ISRCs. An accessToken must be set before making this call.
   *
   * @param {ISRCSubmissionData} metadata
   * @returns {Promise<XMLDocument>}
   */
  async submitISRCs(metadata) {
    if (this.#accessToken === null) {
      throw new Error('MusicBrainz API accessToken is not set');
    }

    const url = new URL("recording/", this.#ws2Base);
    const params = url.searchParams;
    params.set('client', this.#client);
    const doc = generateSubmitISRCsXML(metadata);
    const body = new XMLSerializer().serializeToString(doc);
    console.log(body);
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.#accessToken}`,
        'Content-Type': 'application/xml',
        'Accept': 'application/xml',
      },
      body: body,
    });

    const response = await this.#rateControlledFetch(request);
    return parseXMLPostResponse(await response.text());
  }
}

export { MbFetch };
