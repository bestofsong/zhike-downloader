// @flow
/**
* @Author: wansongHome
* @Date:   2016-07-02T21:55:52+08:00
* @Email:  betterofsong@gmail.com
*/

import RNFS from 'react-native-fs';
import _ from 'lodash';
import PathUtils from 'zhike-path-utils';

type Callback = (...args:Array<any>) => any;
type RecordType = {
  url: string,
  starts: Set<Callback>,
  completions: Set<Callback>,
  progresses: Set<Callback>,
  cancels: Set<Callback>,
  errors: Set<Callback>,
};

const Downloader = function () {
  this.downloadRecords = new Map();// url -> {jobId, startInfo, starts, completions, progresses, cancels, errors}
  this._cancelRequests  = new Map();
};

Downloader.prototype.isDownloading = function (url) {
  return this.downloadRecords.has(url);
};

Downloader.prototype.download = function (params: {
  url: string,
  toPath:string,
  startHandler?:(info: any) => void,
  completionHandler?: (info: any) => void,
  progressHandler?: (info: any) => void,
  cancelHandler?: (info: any) => void,
  errorHandler?: (info: any) => void,
  id?: string,
}) {
  const {
    url,
    toPath,
    startHandler,
    completionHandler,
    progressHandler,
    cancelHandler,
    errorHandler,
    id,
  } = params;
  return this.addDownload(
    url,
    toPath,
    startHandler,
    completionHandler,
    progressHandler,
    cancelHandler,
    errorHandler,
    id || url
    );
};

Downloader.prototype.addDownload = function (url, toPath, startHandler, completionHandler, progressHandler, cancelHandler, errorHandler, id) {
  id = id || url;
  if (typeof url !== 'string' || url.length <= 0 ) {
    throw new Error(`invalid url: ${url}`);
  }

  // ignores toPath, only the first one to download this url is respected
  const alreadyDownloading = this.downloadRecords.has(id);
  this._registerImp(id, url, startHandler, completionHandler, progressHandler, cancelHandler, errorHandler);

  const clearAfterError = () => (RNFS.unlink(toPath)
    .catch((error) => {
      console.warn('error happend during download, and failed to unlink file, maybe have not made it yet: ', toPath, error);
    }));

  const downloadBlock = () => {
    if (!alreadyDownloading) {
      const toPathTmp = `${toPath}.~`;
      RNFS.downloadFile({
        fromUrl: url,
        toFile: toPathTmp,
        begin: (startInfo) => {
          // must check because this job may have been canceled when begin handler is called
          const downloadRecord = { ...startInfo, fromUrl:url, toFile:toPath };
          this._notifyStart(url, downloadRecord);

          const cancel = this._cancelRequests.get(id);
          cancel && cancel(downloadRecord);
          cancel && this._cancelRequests.delete(id);
        },
        // FIXME: will miss intermediate callbacks, event it may be edge ones, should fix this if have time
        progress: _.throttle(
          (progressInfo) => {
            this._notifyProgress(id, progressInfo);
          },
          500,
        ),
      })
      .promise
      .then(completeInfo => Promise.all([RNFS.moveFile(toPathTmp, toPath), completeInfo]))
      .then(([didMove, completeInfo]) => {
        this._notifyComplete(id, completeInfo);
      })
      .catch((err) => {
        clearAfterError()
        .then(() => {
          this._notifyError(id, err);
        });
      });
    } else {
      console.log(`already downloading ${url}`);
      const record = this.downloadRecords.get(id);
      if (record.startInfo) {
        this._notifyStart(id, record.startInfo);
      }
    }
  };

  const ret = new UnRegisterer(() => {
    this.unRegister(id, url, startHandler, completionHandler, progressHandler, cancelHandler, errorHandler);
  });

  PathUtils.mkdirForFilePathIfNeeded(toPath)
  .then(() => {
    downloadBlock();
  })
  .catch((error) => {
    console.error('failed to mkdir, or download failed: ', error);
    clearAfterError().then(() => ret.unRegister());
  });

  return ret;
};

Downloader.prototype._notifyStart = function (url, startInfo) {
  if (this.downloadRecords.has(url)) {
    this.downloadRecords.get(url).startInfo = startInfo;
    this.downloadRecords.get(url).starts.forEach((startHandler) => {
      startHandler(startInfo);
    });
    this.downloadRecords.get(url).starts.clear();
  }
};

Downloader.prototype._notifyProgress = function (url, progressInfo) {
  const downloadRec = this.downloadRecords.get(url);
  downloadRec && downloadRec.progresses && downloadRec.progresses.forEach((progressHandler) => {
    progressHandler && progressHandler(progressInfo);
  });
};

Downloader.prototype._notifyComplete = function (url, completeInfo) {
  if (this.downloadRecords.has(url)) {
    this.downloadRecords.get(url).completions.forEach((completionHandler) => {
      completionHandler(completeInfo);
    });
    this._clearEvents(url);
  }
};

Downloader.prototype._clearEvents = function (url) {
  this.downloadRecords.delete(url);
};

Downloader.prototype._notifyError = function (url, errorInfo) {
  if (this.downloadRecords.has(url)) {
    this.downloadRecords.get(url).errors.forEach((errorHandler) => {
      errorHandler(errorInfo);
    });
    this._clearEvents(url);
  }
};

Downloader.prototype._registerImp = function (id, url, startHandler, completionHandler, progressHandler, cancelHandler, errorHandler) {
  let record:RecordType = this.downloadRecords.get(id);
  if (!record) {
    record = { url, starts:new Set(), completions:new Set(), progresses:new Set(), cancels:new Set(), errors:new Set() };
    this.downloadRecords.set(url, record);
  }
  startHandler && record.starts.add(startHandler);
  completionHandler && record.completions.add(completionHandler);
  progressHandler && record.progresses.add(progressHandler);
  cancelHandler && record.cancels.add(cancelHandler);
  errorHandler && record.errors.add(errorHandler);
};

Downloader.prototype.unRegister = function (id, startHandler, completionHandler, progressHandler, cancelHandler, errorHandler) {
  const record = this.downloadRecords.get(id);
  console.log('unRegistering record: ', record);
  if (record) {
    startHandler && record.starts.delete(startHandler);
    completionHandler && record.completions.delete(completionHandler);
    progressHandler && record.progresses.delete(progressHandler);
    cancelHandler && record.cancels.delete(cancelHandler);
    errorHandler && record.errors.delete(errorHandler);
  }
};

Downloader.prototype.cancelDownload = function (id, callback) {
  const record = this.downloadRecords.get(id);

  const cancelBlock = (startInfo) => {
    RNFS.stopDownload(startInfo.jobId);
    callback && callback(id);
    this._notifyCancel(id);

    // FIXME: react-native-fs bug, stopDownload return nothing
    // .then(() => {
    //   this._notifyCancel(url);
    //   this.downloadRecords.delete(url);
    //   callback && callback(url);
    // })
    // .catch((err) => {
    //   console.error(`failed to cancel download for url: ${url}, err: ${err}`);
    //   this._notifyCancel(url);
    //   this.downloadRecords.delete(url);
    //   callback && callback(url);
    // });
  };

  if (record) {
    if (record.startInfo) {
      cancelBlock(record.startInfo);
      if (record.startInfo.toFile) {
        RNFS.unlink(record.startInfo.toFile)
        .then(() => {
          console.log('did removed file due to cancel: ', record.startInfo.toFile);
        })
        .catch((err) => {
          console.warn('failed to removed file due to cancel, err: ', record.startInfo.toFile, err);
        });
      }
    } else {
      !this._cancelRequests.has(id) && this._cancelRequests.set(id, cancelBlock);
    }
  } else {
    console.warn('no record to cancel download');
  }
};

Downloader.prototype._notifyCancel = function (url) {
  const record = this.downloadRecords.get(url);
  if (record) {
    this.downloadRecords.get(url).cancels.forEach((cancelHandler) => {
      cancelHandler(url);
    });
    this._clearEvents(url);
  }
};

let UnRegisterer = function (executer) {
  this._executer = executer;
};

UnRegisterer.prototype.unRegister = function () {
  this._executer && this._executer();
  this._executer = null;
};

module.exports.downloader = new Downloader();
