import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

export function fakeDownload({ body = "export default 1", status = 200, headers = {}, inspect = () => {} } = {}) {
  return {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    request(url, options, callback) {
      inspect(url, options)
      const request = new EventEmitter()
      request.end = () => {
        const response = new PassThrough()
        response.statusCode = status; response.headers = headers
        callback(response); response.end(body)
      }
      return request
    },
  }
}
