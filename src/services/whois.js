"use strict";

import { lookup } from "whois";

/**
 * Lookup domain info needed for certificate request.
 * @param {string} domain
 * @returns {Promise<{data:string,getEmail:function():string}>}
 */
export default async function whois(domain) {
  return new Promise(async function (resolve) {
    lookup(domain, function (_err, data) {
      resolve({
        data,
        getEmail: () =>
          data.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi)[0],
      });
    });
  });
}
