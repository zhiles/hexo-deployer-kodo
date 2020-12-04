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

    deploy(dir) {
        var bucketManager = new qiniu.rs.BucketManager(this.options.mac,this.options.configOptions);
        let that = this;
        return new Promise((resolve, reject) => {
            Promise.all(
                traversal(dir, src => {
                    const key = path.win32.relative(dir, src).replace(/\\/g, "/");
                    bucketManager.stat(that.options.tokenOptions.scope , key, function(err, ret) {
                        if(!err){
                            that.getEtag(src, function (hash) {
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
                    new qiniu.cdn.CdnManager(this.options.mac)
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

    upload(src, key) {
        //加在该处为了覆盖更新
        let options = Object.assign({}, this.options.tokenOptions, this.options.cover ? { scope: this.options.tokenOptions.scope + ":" + key } : {});
        let uploadToken = new qiniu.rs.PutPolicy(options).uploadToken(this.options.mac);
        let formUploader = new qiniu.form_up.FormUploader(Object.assign(new qiniu.conf.Config(), this.options.configOptions));
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
    // sha1算法
    sha1(content){
        var crypto = require('crypto');
        var sha1 = crypto.createHash('sha1');
        sha1.update(content);
        return sha1.digest();
    }

    getEtag(buffer,callback){
        var that = this;
        // 判断传入的参数是buffer还是stream还是filepath
        var mode = 'buffer';
    
        if(typeof buffer === 'string'){
            buffer = require('fs').createReadStream(buffer);
            mode='stream';
        }else if(buffer instanceof require('stream')){
            mode='stream';
        }
        
    
        // 以4M为单位分割
        var blockSize = 4*1024*1024;
        var sha1String = [];
        var blockCount = 0;
    
        switch(mode){
            case 'buffer':
                var bufferSize = buffer.length;
                blockCount = Math.ceil(bufferSize / blockSize);
    
                for(var i=0;i<blockCount;i++){
                    sha1String.push(that.sha1(buffer.slice(i*blockSize,(i+1)*blockSize)));
                }
                process.nextTick(function(){
                    callback(that.calcEtag(sha1String,blockCount,sha1));
                });
                break;
            case 'stream':
                var stream = buffer;
                stream.on('readable', function() {
                    var chunk;
                    while (chunk = stream.read(blockSize)) {
                        sha1String.push(that.sha1(chunk));
                        blockCount++;
                    }
                });
                stream.on('end',function(){
                    callback(that.calcEtag(sha1String,blockCount));
                });
                break;
        }
    }

    calcEtag(sha1String,blockCount){
        if(!sha1String.length){
            return 'Fto5o-5ea0sNMlW_75VgGJCv2AcJ';
        }
        var sha1Buffer = Buffer.concat(sha1String,blockCount * 20);
        var prefix = 0x16;
        // 如果大于4M，则对各个块的sha1结果再次sha1
        if(blockCount > 1){
            prefix = 0x96;
            sha1Buffer = this.sha1(sha1Buffer);
        }

        sha1Buffer = Buffer.concat(
            [new Buffer([prefix]),sha1Buffer],
            sha1Buffer.length + 1
        );

        return sha1Buffer.toString('base64')
            .replace(/\//g,'_').replace(/\+/g,'-');

    }
};
