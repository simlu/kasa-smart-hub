import Joi from 'joi-strict';
import tplink from 'tplink-smarthome-api';
import configSchema from '../resources/config-schema.js';
import computeLinks from '../util/compute-links.js';
import secondsToHumansReadable from '../util/seconds-to-human-readable.js';
import computeDelay from '../util/compute-delay.js';
import onlyOnce from '../util/only-once.js';
import ForEach from '../util/for-each.js';
import Log from '../util/log.js';
import Apply from '../util/apply.js';

const { Client } = tplink;

export default (config_) => {
  const config = {
    discoveryConfig: {},
    ...config_
  };
  Joi.assert(config, configSchema);

  const links = computeLinks(config);
  const log = Log(config);
  const client = new Client();
  const forEach = ForEach(client);
  const apply = Apply(log);

  const updateDeviceTimer = async (device, state) => onlyOnce(`update-timer: ${device.alias}`, async () => {
    const delay = computeDelay(device.alias, state, config);
    if (delay === 0) {
      return;
    }
    const rules = await apply(device, 'timer.getRules');
    if (rules.err_code !== 0) {
      return;
    }
    if (rules.rule_list.some((r) => r.enable === 1 && (r.remain - delay) < 10)) {
      return;
    }
    const newState = await apply(device, 'getPowerState');
    if (newState === state) {
      log(`Timer Started: ${device.alias} - ${state ? 'OFF' : 'ON'} in ${secondsToHumansReadable(delay)}`);
      await apply(device, 'timer.addRule', { delay, powerState: !state });
    }
  });

  const onDevicePowerStateChange = async (device, state) => {
    log('debug', `State Changed: ${device.alias} @ ${state ? 'on' : 'off'}`);
    if (device.alias in links) {
      const group = links[device.alias];
      await onlyOnce(
        `power-toggle: ${[device.alias, ...group].sort().join(' || ')}`,
        async () => {
          log(`Link Triggered: ${device.alias} -> ${[...group].join(', ')} @ ${state ? 'on' : 'off'}`);
          await forEach(
            (d) => d.status === 'online' && group.has(d.alias),
            (d) => apply(d, 'setPowerState', state)
          );
        }
      );
    }
  };

  const onDeviceSync = async (device, state) => {
    await updateDeviceTimer(device, state);
  };

  client.on('device-new', (device) => {
    log(`New Device: ${device.alias}`);
    device.addListener('power-on', () => onDevicePowerStateChange(device, true));
    device.addListener('power-off', () => onDevicePowerStateChange(device, false));
    device.addListener('power-update', async (state) => onDeviceSync(device, state));
    // fast polling for linked devices
    if (device.alias in links) {
      device.startPolling(500);
    }
  });

  return {
    start: () => {
      client.startDiscovery({
        broadcast: '192.168.0.255',
        port: 56888,
        breakoutChildren: true,
        discoveryInterval: 10000,
        discoveryTimeout: 0,
        offlineTolerance: 3,
        ...config.discoveryConfig
      });
    },
    stop: () => {
      [...client.devices.values()].forEach((d) => {
        d.stopPolling();
      });
      client.stopDiscovery();
    },
    getDevices: () => [...client.devices.values()]
  };
};
