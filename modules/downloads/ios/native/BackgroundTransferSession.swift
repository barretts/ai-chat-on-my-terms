import Foundation

/// Native half of the downloads-ios port. The host app exposes these operations
/// through its React Native/Expo module and forwards events to IOSBackgroundDownloads.
/// transferID lives in URLSessionTask.taskDescription so it survives process death.
public final class BackgroundTransferSession: NSObject, URLSessionDownloadDelegate {
    public struct Snapshot {
        public let taskID: Int
        public let transferID: String?
        public let state: String
        public let receivedBytes: Int64
        public let expectedBytes: Int64?
        public let temporaryPath: String?
        public let errorCode: String?
    }

    public enum Event {
        case progress(taskID: Int, receivedBytes: Int64, expectedBytes: Int64?)
        case completed(taskID: Int, temporaryPath: String)
        case failed(taskID: Int, errorCode: String)
        case canceled(taskID: Int)
    }

    public var onEvent: ((Event) -> Void)?
    private var backgroundCompletionHandler: (() -> Void)?

    private let identifier: String
    private let fileManager: FileManager
    private let lock = NSRecursiveLock()
    private var completedPaths: [Int: URL] = [:]
    private var pausedTaskIDs = Set<Int>()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    public init(identifier: String = "com.locallab.model-downloads", fileManager: FileManager = .default) {
        self.identifier = identifier
        self.fileManager = fileManager
        super.init()
    }

    /// Creates suspended; the caller persists taskIdentifier before calling resume.
    public func create(url: URL, transferID: String) throws -> Int {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else {
            throw NSError(domain: "LocalLabDownload", code: 1, userInfo: [NSLocalizedDescriptionKey: "credential-free HTTPS required"])
        }
        let task = session.downloadTask(with: url)
        task.taskDescription = transferID
        return task.taskIdentifier
    }

    /// Called by UIApplicationDelegate when iOS relaunches the host for this session.
    public func setBackgroundCompletionHandler(_ handler: @escaping () -> Void) {
        lock.lock(); backgroundCompletionHandler = handler; lock.unlock()
    }

    public func resume(taskID: Int, resumeData: String? = nil) async throws -> Int {
        if let resumeData, let data = Data(base64Encoded: resumeData) {
            guard let oldTask = await task(taskID), let transferID = oldTask.taskDescription else { throw missingTask() }
            let resumed = session.downloadTask(withResumeData: data)
            resumed.taskDescription = transferID
            resumed.resume()
            return resumed.taskIdentifier
        }
        guard let task = await task(taskID) else { throw missingTask() }
        task.resume()
        return task.taskIdentifier
    }

    public func cancel(taskID: Int) async throws {
        guard let task = await task(taskID) else { return }
        task.cancel()
    }

    public func pause(taskID: Int) async throws -> Data? {
        guard let download = await task(taskID) as? URLSessionDownloadTask else { throw missingTask() }
        return await withCheckedContinuation { continuation in
            lock.lock(); pausedTaskIDs.insert(taskID); lock.unlock()
            download.cancel(byProducingResumeData: { data in
                continuation.resume(returning: data?.base64EncodedString())
            })
        }
    }

    public func enumerate() async -> [Snapshot] {
        await withCheckedContinuation { continuation in
            session.getAllTasks { [weak self] tasks in
                guard let self else { continuation.resume(returning: []); return }
                let snapshots = tasks.map { task -> Snapshot in
                    let state: String
                    switch task.state {
                    case .running: state = "running"
                    case .suspended: state = "suspended"
                    case .canceling: state = "canceled"
                    case .completed: state = "completed"
                    @unknown default: state = "failed"
                    }
                    let download = task as? URLSessionDownloadTask
                    let expected = download?.countOfBytesExpectedToReceive ?? -1
                    return Snapshot(
                        taskID: task.taskIdentifier,
                        transferID: task.taskDescription,
                        state: state,
                        receivedBytes: max(0, task.countOfBytesReceived),
                        expectedBytes: expected >= 0 ? expected : nil,
                        temporaryPath: self.path(for: task.taskIdentifier),
                        errorCode: nil
                    )
                }
                continuation.resume(returning: snapshots)
            }
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        onEvent?(.progress(
            taskID: downloadTask.taskIdentifier,
            receivedBytes: max(0, totalBytesWritten),
            expectedBytes: totalBytesExpectedToWrite >= 0 ? totalBytesExpectedToWrite : nil
        ))
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            let staging = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("LocalLab/ModelDownloads", isDirectory: true)
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
            let destination = staging.appendingPathComponent(UUID().uuidString + ".partial")
            try fileManager.moveItem(at: location, to: destination)
            lock.lock(); completedPaths[downloadTask.taskIdentifier] = destination; lock.unlock()
            onEvent?(.completed(taskID: downloadTask.taskIdentifier, temporaryPath: destination.path))
        } catch {
            onEvent?(.failed(taskID: downloadTask.taskIdentifier, errorCode: "staging-failed"))
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled {
            lock.lock(); let wasPaused = pausedTaskIDs.remove(task.taskIdentifier) != nil; lock.unlock()
            if wasPaused { return }
            onEvent?(.canceled(taskID: task.taskIdentifier))
        } else {
            // Do not forward localizedDescription: it can contain the request URL.
            onEvent?(.failed(taskID: task.taskIdentifier, errorCode: "urlsession-\(abs(nsError.code))"))
        }
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock(); let completion = backgroundCompletionHandler; backgroundCompletionHandler = nil; lock.unlock()
        DispatchQueue.main.async { completion?() }
    }

    private func task(_ taskID: Int) async -> URLSessionTask? {
        await withCheckedContinuation { continuation in
            session.getAllTasks { continuation.resume(returning: $0.first { $0.taskIdentifier == taskID }) }
        }
    }

    private func path(for taskID: Int) -> String? {
        lock.lock(); defer { lock.unlock() }
        return completedPaths[taskID]?.path
    }

    private func missingTask() -> NSError {
        NSError(domain: "LocalLabDownload", code: 2, userInfo: [NSLocalizedDescriptionKey: "background task not found"])
    }
}
