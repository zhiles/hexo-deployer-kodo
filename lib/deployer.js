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
        //构建bucketmanager对象
        var client = new qiniu.rs.Client();
        let that = this;
        return new Promise((resolve, reject) => {
            Promise.all(
                traversal(dir, src => {
                    const key = path.win32.relative(dir, src).replace(/\\/g, "/");
                    client.stat(that.options.tokenOptions.scope , key, function(err, ret) {
                        if(!err){
                            getEtag(src, function (hash) {
                                if(hash != ret.hash){
                                    that.upload(src, key).finally(() => {
                                        console.log(key);
                                    });
                                }
                            });
                        }else{
                            // 文件不存在
                            if(err.code == 612){
                                that.upload(src, key).finally(() => {
                                    console.log(key);
                                });
                            }
                        }
                    })
                   
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

    getEtag(buffer,callback){

        // 判断传入的参数是buffer还是stream还是filepath
        var mode = 'buffer';
    
        if(typeof buffer === 'string'){
            buffer = require('fs').createReadStream(buffer);
            mode='stream';
        }else if(buffer instanceof require('stream')){
            mode='stream';
        }
    
        // sha1算法
        var sha1 = function(content){
            var crypto = require('crypto');
            var sha1 = crypto.createHash('sha1');
            sha1.update(content);
            return sha1.digest();
        };
    
        // 以4M为单位分割
        var blockSize = 4*1024*1024;
        var sha1String = [];
        var prefix = 0x16;
        var blockCount = 0;
    
        switch(mode){
            case 'buffer':
                var bufferSize = buffer.length;
                blockCount = Math.ceil(bufferSize / blockSize);
    
                for(var i=0;i<blockCount;i++){
                    sha1String.push(sha1(buffer.slice(i*blockSize,(i+1)*blockSize)));
                }
                process.nextTick(function(){
                    callback(calcEtag());
                });
                break;
            case 'stream':
                var stream = buffer;
                stream.on('readable', function() {
                    var chunk;
                    while (chunk = stream.read(blockSize)) {
                        sha1String.push(sha1(chunk));
                        blockCount++;
                    }
                });
                stream.on('end',function(){
                    callback(calcEtag());
                });
                break;
        }
    }

    calcEtag(){
        if(!sha1String.length){
            return 'Fto5o-5ea0sNMlW_75VgGJCv2AcJ';
        }
        var sha1Buffer = Buffer.concat(sha1String,blockCount * 20);

        // 如果大于4M，则对各个块的sha1结果再次sha1
        if(blockCount > 1){
            prefix = 0x96;
            sha1Buffer = sha1(sha1Buffer);
        }

        sha1Buffer = Buffer.concat(
            [new Buffer([prefix]),sha1Buffer],
            sha1Buffer.length + 1
        );

        return sha1Buffer.toString('base64')
            .replace(/\//g,'_').replace(/\+/g,'-');

    }
};
