var assert = require('assert');
var async = require('async');
var util = require('util');

var helper = require('../../test-helper.js');
var Client = require('../../../lib/client.js');
var types = require('../../../lib/types.js');
var utils = require('../../../lib/utils.js');
var reconnection = require('../../../lib/policies/reconnection.js');

describe('reconnection', function () {
  this.timeout(120000);
  describe('when a node is back UP', function () {
    it('should re-prepare on demand', function (done) {
      var dummyClient = new Client(helper.baseOptions);
      var keyspace = helper.getRandomName('ks');
      var table = helper.getRandomName('tbl');
      var insertQuery1 = util.format('INSERT INTO %s (id, text_sample) VALUES (?, ?)', table);
      var insertQuery2 = util.format('INSERT INTO %s (id, int_sample) VALUES (?, ?)', table);
      var client = new Client(utils.extend({
        keyspace: keyspace,
        contactPoints: helper.baseOptions.contactPoints,
        policies: { reconnection: new reconnection.ConstantReconnectionPolicy(100)}
      }));
      async.series([
        function removeCcm(next) {
          helper.ccmHelper.remove(function () {
            //Ignore error
            next()
          });
        },
        helper.ccmHelper.start(2),
        function createKs(next) {
          dummyClient.execute(helper.createKeyspaceCql(keyspace, 3), helper.waitSchema(dummyClient, next));
        },
        function createTable(next) {
          dummyClient.execute(helper.createTableCql(keyspace + '.' + table), helper.waitSchema(dummyClient, next));
        },
        //Connect using an active keyspace
        client.connect.bind(client),
        function insert1(next) {
          //execute a couple of times to ensure it is prepared on all hosts
          async.times(15, function (n, timesNext) {
            client.execute(insertQuery1, [types.uuid(), n.toString()], {prepare: 1}, timesNext);
          }, next);
        },
        function killNode(next) {
          helper.ccmHelper.exec(['node1', 'stop', '--not-gently'], next);
        },
        function insert2(next) {
          //Prepare and execute a new Query, that it is NOT prepared on the stopped node :)
          //execute a couple of times to ensure it is prepared on the remaining hosts
          async.times(3, function (n, timesNext) {
            client.execute(insertQuery2, [types.uuid(), n], {prepare: 1}, timesNext);
          }, next);
        },
        function restart(next) {
          helper.ccmHelper.exec(['node1', 'start'], next);
        },
        function killTheOther(next) {
          helper.ccmHelper.exec(['node2', 'stop'], next);
        },
        function insert1_plus (next) {
          async.times(15, function (n, timesNext) {
            client.execute(insertQuery1, [types.uuid(), n.toString()], {prepare: 1}, timesNext);
          }, next);
        },
        function insert2_plus (next) {
          async.times(1, function (n, timesNext) {
            client.execute(insertQuery2, [types.uuid(), n], {prepare: 1}, timesNext);
          }, next);
        }
      ], done);
    });
    it('should reconnect and re-prepare once there is an available host', function (done) {
      var dummyClient = new Client(helper.baseOptions);
      var keyspace = helper.getRandomName('ks');
      var table = helper.getRandomName('tbl');
      var insertQuery1 = util.format('INSERT INTO %s (id, text_sample) VALUES (?, ?)', table);
      var client = new Client({
        keyspace: keyspace,
        contactPoints: helper.baseOptions.contactPoints,
        policies: { reconnection: new reconnection.ConstantReconnectionPolicy(100)}
      });
      async.series([
        function removeCcm(next) {
          helper.ccmHelper.remove(function () {
            //Ignore error
            next()
          });
        },
        helper.ccmHelper.start(1),
        function createKs(next) {
          dummyClient.execute(helper.createKeyspaceCql(keyspace, 3), helper.waitSchema(dummyClient, next));
        },
        function createTable(next) {
          dummyClient.execute(helper.createTableCql(keyspace + '.' + table), helper.waitSchema(dummyClient, next));
        },
        //Connect using an active keyspace
        client.connect.bind(client),
        function insert1(next) {
          //execute a couple of times to ensure it is prepared on all hosts
          async.times(15, function (n, timesNext) {
            client.execute(insertQuery1, [types.uuid(), n.toString()], {prepare: 1}, timesNext);
          }, next);
        },
        function killNode(next) {
          helper.ccmHelper.exec(['node1', 'stop', '--not-gently'], next);
        },
        function insert2(next) {
          //execute a couple of times to even though the cluster is DOWN
          async.timesSeries(20, function (n, timesNext) {
            client.execute(insertQuery1, [types.uuid(), n], {prepare: 1}, function (err) {
              //It should callback in error
              assert.ok(err);
              setTimeout(timesNext, 100);
            });
          }, next);
        },
        function restart(next) {
          helper.ccmHelper.exec(['node1', 'start'], helper.wait(3000, next));
        },
        function insert1_plus(next) {
          //The cluster should be UP!
          async.times(15, function (n, timesNext) {
            client.execute(insertQuery1, [types.uuid(), n.toString()], {prepare: 1}, timesNext);
          }, next);
        },
        function assertResults(next) {
          client.execute(util.format('SELECT * from %s', table), function (err, result) {
            assert.ifError(err);
            assert.ok(result);
            //It should have inserted 15+15
            assert.strictEqual(result.rows.length, 30);
            next();
          });
        }
      ], done);
    });
  });
});