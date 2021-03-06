#!/usr/bin/env node

process.title = 's32couchdb';

var util = require('util');
var url = require('url');
var zlib = require('zlib');
var qs = require('querystring').stringify;
var StringDecoder = require('string_decoder').StringDecoder;
var Writable = require('stream').Writable;
var nano = require('nano');
var utils = require('../lib/utils.js');

var argv = utils.config({
    demand: ['bucket', 'database'],
    optional: ['prefix', 'marker'],
    usage: 'Import CouchDB Database from S3\n' +
           'Usage: s32couchdb --bucket my-bucket --database "http://localhost:5984/my-database" [--prefix "prefix/my-database" --marker "prefix/my-database-2010-12-31"]'
});

var dbUrl = url.parse(argv.database);
var dbName = dbUrl.pathname.split('/')[1];
var db = nano(url.format({
    protocol: dbUrl.protocol,
    host: dbUrl.host,
    auth: dbUrl.auth
})).use(dbName);

// ImportStream class writes to CouchDB
//
util.inherits(ImportStream, Writable);
function ImportStream(opts) {
    Writable.call(this, opts);
    this._buffer = '';
    this._bufferLim = Math.pow(2, 18)
    this._decoder = new StringDecoder('utf8')
}
ImportStream.prototype._write = function(chunk, encoding, done) {
    this._buffer += this._decoder.write(chunk);
    if (this._buffer.length < this._bufferLim) return done();

    this.flush(done);
};
ImportStream.prototype.flush = function(done) {
    var docs = this._buffer.split('\n');
    this._buffer = docs.pop();

    docs = docs.filter(function(v) {
        return v.length > 0;
    }).map(function(v) {
        v = JSON.parse(v);
        // support wrapped docs.
        if (v.doc && v.doc._id) return v.doc;
        return v;
    });

    db.bulk({ new_edits: false, docs: docs }, {}, done);
};

var d = new Date(Date.now() - 864e5); // Look 1 day back.

var prefix = argv.prefix || util.format('db/%s-', dbName);
var marker = argv.marker || util.format('%s-%s-%s-%s', prefix, d.getUTCFullYear(), utils.pad(d.getUTCMonth() + 1), utils.pad(d.getUTCDate()))

utils.s3.listObjects({
    Bucket: argv.bucket,
    Prefix: prefix,
    Marker: marker
}, function(err, data) {
    if (err) throw err;
    if (data.Contents.length === 0)
        throw new Error('Unable to locate db on s3');

    var key = data.Contents.pop().Key

    var reader = utils.s3.getObject({
        Bucket: argv.bucket,
        Key: key
    }).createReadStream();

    var importer = new ImportStream();
    var finish = function() {
        importer.flush(function(err) {
            if (err) throw err;
            console.log('%s : Imported %s into %s/%s', (new Date()), key, dbUrl.host, dbName);
        });
    };

    if (/\.gz$/.test(key)) {
        var gunzip = zlib.createGunzip();
        reader.pipe(gunzip).pipe(importer, { end: false });
        gunzip.on('end', finish);
    } else {
        reader.pipe(importer, { end: false });
        reader.on('end', finish);
    }
});
