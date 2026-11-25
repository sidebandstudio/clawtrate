import ExpoModulesCore

/// Pause a transfer while this many bytes wait unread, and go on once they are read.
private let holdBytes = 1 << 20

/// The iPhone host's HTTP GET for the pictures core reads from the gateway (`HttpFetch` in
/// packages/core/src/host.ts; docs/decisions.md, The iOS app). Its own URLSession, ephemeral,
/// with no cache, no cookie store and no credential store, so a request carries only the
/// headers it is given and nothing is written to disk. A redirect is refused, never followed.
/// The body comes in parts, one per read; a cancel stops the transfer. JavaScript names each
/// request by an id (`src/host/fetch.ts`).
public final class ClawtrateFetchModule: Module {
  private let queue = DispatchQueue(label: "dev.clawtrate.fetch")
  private let reads: Reads

  public required init(appContext: AppContext) {
    reads = Reads(queue: queue)
    super.init(appContext: appContext)
  }

  public func definition() -> ModuleDefinition {
    Name("ClawtrateFetch")

    OnDestroy {
      self.reads.close()
    }

    AsyncFunction("start") { (id: String, url: String, authorization: String?, promise: Promise) in
      self.reads.start(id: id, url: url, authorization: authorization, promise: promise)
    }.runOnQueue(queue)

    AsyncFunction("read") { (id: String, promise: Promise) in
      self.reads.read(id: id, promise: promise)
    }.runOnQueue(queue)

    AsyncFunction("cancel") { (id: String) in
      self.reads.cancel(id: id)
    }.runOnQueue(queue)
  }
}

/// Every request under way, touched only on `queue`, where the session's callbacks run too.
private final class Reads: NSObject, URLSessionDataDelegate {
  private final class Read {
    let task: URLSessionDataTask
    /// Answered with the status and headers, or the failure before them.
    var started: Promise?
    /// A read waiting for the next part.
    var waiting: Promise?
    var parts: [Data] = []
    var held = 0
    var ended = false
    var failure: (code: String, message: String)?

    init(task: URLSessionDataTask, started: Promise) {
      self.task = task
      self.started = started
    }
  }

  private var session: URLSession!
  private var byId: [String: Read] = [:]
  private var idOf: [Int: String] = [:]

  init(queue: DispatchQueue) {
    super.init()
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.urlCredentialStorage = nil
    let callbacks = OperationQueue()
    callbacks.maxConcurrentOperationCount = 1
    callbacks.underlyingQueue = queue
    session = URLSession(configuration: config, delegate: self, delegateQueue: callbacks)
  }

  func close() {
    session.invalidateAndCancel()
  }

  func start(id: String, url: String, authorization: String?, promise: Promise) {
    guard let address = URL(string: url), address.scheme == "https" else {
      return promise.reject("ERR_ADDRESS", "Only an https address is fetched.")
    }
    guard byId[id] == nil else {
      return promise.reject("ERR_ID", "This request id is already in use.")
    }
    var request = URLRequest(url: address, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = "GET"
    request.httpShouldHandleCookies = false
    if let authorization {
      request.setValue(authorization, forHTTPHeaderField: "Authorization")
    }
    let task = session.dataTask(with: request)
    byId[id] = Read(task: task, started: promise)
    idOf[task.taskIdentifier] = id
    task.resume()
  }

  func read(id: String, promise: Promise) {
    guard let read = byId[id] else {
      return promise.reject("ERR_CANCELLED", "The request was cancelled.")
    }
    if !read.parts.isEmpty {
      let part = read.parts.removeFirst()
      read.held -= part.count
      if read.held < holdBytes {
        read.task.resume()
      }
      return promise.resolve(part)
    }
    if let failure = read.failure {
      drop(id)
      return promise.reject(failure.code, failure.message)
    }
    if read.ended {
      drop(id)
      return promise.resolve(nil)
    }
    read.waiting = promise
  }

  func cancel(id: String) {
    guard let read = byId[id] else {
      return
    }
    drop(id)
    read.task.cancel()
    read.started?.reject("ERR_CANCELLED", "The request was cancelled.")
    read.waiting?.reject("ERR_CANCELLED", "The request was cancelled.")
  }

  private func drop(_ id: String) {
    if let read = byId.removeValue(forKey: id) {
      idOf.removeValue(forKey: read.task.taskIdentifier)
    }
  }

  private func found(_ task: URLSessionTask) -> (String, Read)? {
    guard let id = idOf[task.taskIdentifier], let read = byId[id] else {
      return nil
    }
    return (id, read)
  }

  /// The failure goes to whoever waits for it now, or to the next read after the parts held.
  private func fail(_ id: String, _ read: Read, code: String, message: String) {
    if let started = read.started {
      drop(id)
      return started.reject(code, message)
    }
    if let waiting = read.waiting {
      drop(id)
      return waiting.reject(code, message)
    }
    read.failure = (code, message)
  }

  // MARK: - URLSessionDataDelegate

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // Refused, as a fetch with `redirect: "error"` refuses one: the request ends here.
    completionHandler(nil)
    task.cancel()
    if let (id, read) = found(task) {
      fail(id, read, code: "ERR_REDIRECT", message: "The answer was a redirect, which is not followed.")
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    // The server's certificate is checked as the system checks any. No credential is offered.
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
      completionHandler(.performDefaultHandling, nil)
    } else {
      completionHandler(.rejectProtectionSpace, nil)
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let (_, read) = found(dataTask), let started = read.started else {
      return completionHandler(.cancel)
    }
    read.started = nil
    let http = response as? HTTPURLResponse
    var headers: [String: String] = [:]
    for (name, value) in http?.allHeaderFields ?? [:] {
      if let name = name as? String, let value = value as? String {
        headers[name.lowercased()] = value
      }
    }
    started.resolve(["status": http?.statusCode ?? 0, "headers": headers])
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let (_, read) = found(dataTask) else {
      return
    }
    if let waiting = read.waiting {
      read.waiting = nil
      return waiting.resolve(data)
    }
    read.parts.append(data)
    read.held += data.count
    if read.held >= holdBytes {
      dataTask.suspend()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let (id, read) = found(task) else {
      return
    }
    if let error {
      return fail(id, read, code: "ERR_FETCH", message: error.localizedDescription)
    }
    read.ended = true
    if let waiting = read.waiting {
      read.waiting = nil
      drop(id)
      waiting.resolve(nil)
    }
  }
}
