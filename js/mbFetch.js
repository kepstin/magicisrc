const requestDelayMinimum = 1000; // ms
const rateControlStorage = 'mbFetchRateControl';
const rateControlDefault = {
  delay: requestDelayMinimum,
  exponent: 0,
  lastRequest: 0,
};

class MbFetch {
  #ws2Base;

  #cachedRelease = {};

  constructor(ws2Base) {
    this.#ws2Base = ws2Base;
  }

  async #delayToNextRequest() {
    const rateControl = Object.assign({}, rateControlDefault, JSON.parse(window.localStorage.getItem(rateControlStorage)));

    const elapsed = performance.now() - (rateControl.lastRequest - performance.timeOrigin);
    const delay = rateControl.delay - elapsed;
    if (delay > 0) {
      console.log(`MbFetch: last request was ${elapsed} ms ago, waiting ${delay} ms before starting another one`);
      await new Promise((resolve) => { setTimeout(() => resolve(), delay)});
    } else {
      console.log(`MbFetch: last request was ${elapsed} ms ago, starting another one`);
    }

    rateControl.lastRequest = performance.now() + performance.timeOrigin;
    window.localStorage.setItem(rateControlStorage, JSON.stringify(rateControl));
  }

  #adjustRateControl(slowDown) {
    const rateControl = Object.assign({}, rateControlDefault, JSON.parse(window.localStorage.getItem(rateControlStorage)));

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

    window.localStorage.setItem(rateControlStorage, JSON.stringify(rateControl));
  }

  async #fetchInternal(url, retries = 2) {
    await this.#delayToNextRequest();

    const response = await window.fetch(url);
    const slowDown = (response.status === 429 || response.status >= 500);
    this.#adjustRateControl(slowDown);

    if (retries > 0 && slowDown) {
      console.log(`MbFetch: server reported status ${response.status}, ${retries} retries remaining`);
      return this.#fetchInternal(url, retries - 1);
    }

    if (response.status !== 200) {
      throw new Error(`MusicBrainz API request failed with status ${response.status} ${response.statusText}`);
    }

    return response;
  }

  async #rateControlledFetch(url) {
    if (typeof(navigator.locks) !== "undefined") {
      return await navigator.locks.request(rateControlStorage, () => { return this.#fetchInternal(url); });
    } else {
      return await this.#fetchInternal(url);
    }
  }

  async fetchRelease(mbid) {
    if (this.#cachedRelease.id === mbid) {
      return this.#cachedRelease;
    }

    const url = new URL("release/" + mbid, this.#ws2Base);
    const params = url.searchParams;

    params.set('fmt', 'json');
    params.set('inc', 'artist-credits+isrcs+labels+recordings');

    const response = await this.#rateControlledFetch(url);
    const body = await response.json();
    if (body['error']) {
      throw new Error(`MusicBrainz release lookup returned error: ${body['error']}`);
    }

    this.#cachedRelease = body;
    return body;
  }
}

export { MbFetch };
