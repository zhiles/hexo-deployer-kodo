'use strict';

const fs = require('hexo-fs');
const qiniu = require('qiniu');
const path = require("path");

const traversal = function (src, method) {
    let queue = [];
    let stat = fs.statSync(src);
    if (stat.isFile()) {
        queue.push(method(src));
    } else if (stat.isDirectory()) {
        for (let dir of fs.readdirSync(src)) {
            queue.push(...traversal(path.join(src, dir), method));
        }
    }
    return queue;
};

module.exports = class Deployer {
    constructor(options) {
        this.options = {
            mac: null,
            accessKey: null,
            secretKey: null,
            dirsToRefresh: [],
            tokenOptions: {
                scope: null
            },
            configOptions: {
                zone: null
            },
            cover: false,
            refreshCdn: false
        };
        Object.assign(this.options, options);

        this.options.mac = new qiniu.auth.digest.Mac(options.accessKey, options.secretKey);
        this.options.configOptions.zone = qiniu.zone[options.configOptions.zone];
    }

    createCdnManager(mac) {
        return new qiniu.cdn.CdnManager(mac);
    }

    createUploadToken(mac, putPolicyOptions) {
        return new qiniu.rs.PutPolicy(putPolicyOptions).uploadToken(mac);
    }

    createConfig(configOptions) {
        let config = new qiniu.conf.Config();
        return Object.assign(config, configOptions);
    }

    deploy(dir) {
        let that = this;
        return new Promise((resolve, reject) => {
            Promise.all(
                traversal(dir, src => {
                    const key = path.win32.relative(dir, src).replace(/\\/g, "/");
                    that.upload(src, key).finally(() => {
                        console.log(key);
                    });
                })
            ).then(() => {
                console.log("upload to qiniu finished!");
                if (that.options.refreshCdn) {
                    that.createCdnManager(this.options.mac)
                        .refreshDirs(that.options.dirsToRefresh, (respErr, respBody, respInfo) => {
                            if (respInfo.statusCode === 200) {
                                resolve(respErr, respBody, respInfo);
                            } else {
                                reject(respErr, respBody, respInfo);
                            }
                        });
                }
            }).catch((e) => {
                console.log("upload to qiniu fail!", e);
            });
        }).then((data) => {
            console.log("refresh qiniu finished!", data);
        }).catch((e) => {
            console.log("refresh qiniu fail!", e);
        });
    }

    upload(src, key, tokenOptions, configOptions) {
        let uploadToken = this.createUploadToken(this.options.mac, Object.assign({}, this.options.tokenOptions, tokenOptions, this.options.cover ? { scope: this.options.tokenOptions.scope + ":" + key } : {}));
        let formUploader = new qiniu.form_up.FormUploader(this.createConfig(Object.assign({}, this.options.configOptions, configOptions)));
        let putExtra = new qiniu.form_up.PutExtra();
        return new Promise((resolve, reject) => {
            formUploader.putFile(uploadToken, key, src, putExtra, (respErr, respBody, respInfo) => {
                if (respInfo.statusCode === 200) {
                    resolve(respErr, respBody, respInfo);
                } else {
                    reject(respErr, respBody, respInfo);
                }
            });
        });
    }
};
