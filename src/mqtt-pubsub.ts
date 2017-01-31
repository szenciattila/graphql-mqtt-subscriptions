import {PubSubEngine} from 'graphql-subscriptions/dist/pubsub';
import {connect, Client, ClientPublishOptions, ClientSubscribeOptions, Granted} from 'mqtt';
import {each} from 'async';

export interface PubSubMQTTOptions {
  brokerUrl?: string;
  client?: Client;
  connectionListener?: (err: Error) => void;
  publishOptions?: PublishOptionsResolver;
  subscribeOptions?: SubscribeOptionsResolver;
  onMQTTSubscribe?: (id: number, granted: Granted) => void;
  triggerTransform?: TriggerTransform;
  parseMessageWithEncoding?: string;
}

export class MQTTPubSub implements PubSubEngine {

  constructor(options: PubSubMQTTOptions = {}) {
    this.triggerTransform = options.triggerTransform || (trigger => trigger as string);
  
    if (options.client) {
      this.mqttConnection = options.client;
    } else {
      const brokerUrl = options.brokerUrl || 'mqtt://localhost';
      this.mqttConnection = connect(brokerUrl);
    }
    
    this.mqttConnection.on('message', this.onMessage.bind(this));

    if (options.connectionListener) {
      this.mqttConnection.on('connect', options.connectionListener);
      this.mqttConnection.on('error', options.connectionListener);
    } else {
      this.mqttConnection.on('error', console.error);
    }

    this.subscriptionMap = {};
    this.subsRefsMap = {};
    this.currentSubscriptionId = 0;
    this.onMQTTSubscribe = options.onMQTTSubscribe || (() => null);
    this.publishOptionsResolver = options.publishOptions || (() => Promise.resolve({}));
    this.subscribeOptionsResolver = options.subscribeOptions || (() => Promise.resolve({}));
    this.parseMessageWithEncoding = options.parseMessageWithEncoding;
  }

  public publish(trigger: string, payload: any): boolean {
    this.mqttConnection.publish(trigger, JSON.stringify(payload));
    return true;
  }

  public subscribe(trigger: string, onMessage: Function, options?: Object): Promise<number> {
    const triggerName: string = this.triggerTransform(trigger, options);
    const id = this.currentSubscriptionId++;
    this.subscriptionMap[id] = [triggerName, onMessage];
  
    let refs = this.subsRefsMap[triggerName];
    if (refs && refs.length > 0) {
      const newRefs = [...refs, id];
      this.subsRefsMap[triggerName] = newRefs;
      return Promise.resolve(id);
      
    } else {
      return new Promise<number>((resolve, reject) => {
        // 1. Resolve options object
        this.subscribeOptionsResolver(trigger, options).then(subscriptionOptions => {
          
          // 2. Subscribing using MQTT
          this.mqttConnection.subscribe(triggerName, {qos: 0, ...subscriptionOptions}, (err, granted) => {
            if (err) {
              reject(err);
            } else {
              
              // 3. Saving the new sub id
              const subscriptionIds = this.subsRefsMap[triggerName] || [];
              this.subsRefsMap[triggerName] = [...subscriptionIds, id];
              
              // 4. Resolving the subscriptions id to the Subscription Manager
              resolve(id);
              
              // 5. Notify implementor on the subscriptions ack and QoS
              this.onMQTTSubscribe(id, granted);
            }
          });
        }).catch(err => reject(err));
      });
    }
  }

  public unsubscribe(subId: number) {
    const [triggerName = null] = this.subscriptionMap[subId] || [];
    const refs = this.subsRefsMap[triggerName];

    if (!refs)
      throw new Error(`There is no subscription of id "${subId}"`);

    let newRefs;
    if (refs.length === 1) {
      this.mqttConnection.unsubscribe(triggerName);
      newRefs = [];

    } else {
      const index = refs.indexOf(subId);
      if (index != -1) {
        newRefs = [...refs.slice(0, index), ...refs.slice(index + 1)];
      }
    }

    this.subsRefsMap[triggerName] = newRefs;
    delete this.subscriptionMap[subId];
  }

  private onMessage(topic: string, message: Buffer) {
    const subscribers = this.subsRefsMap[topic];

    // Don't work for nothing..
    if (!subscribers || !subscribers.length)
      return;

    const messageString = message.toString(this.parseMessageWithEncoding);
    console.log('got message', messageString);
    let parsedMessage;
    try {
      parsedMessage = JSON.parse(messageString);
    } catch (e) {
      parsedMessage = messageString;
    }

    each(subscribers, (subId, cb) => {
      const [triggerName, listener] = this.subscriptionMap[subId];
      listener(parsedMessage);
      cb();
    })
  }

  private triggerTransform: TriggerTransform;
  private onMQTTSubscribe: SubscribeHandler;
  private subscribeOptionsResolver: SubscribeOptionsResolver;
  private publishOptionsResolver: PublishOptionsResolver;
  private mqttConnection: Client;

  private subscriptionMap: {[subId: number]: [string , Function]};
  private subsRefsMap: {[trigger: string]: Array<number>};
  private currentSubscriptionId: number;
  private parseMessageWithEncoding: string;
}

export type Path = Array<string | number>;
export type Trigger = string | Path;
export type TriggerTransform = (trigger: Trigger, channelOptions?: Object) => string;
export type SubscribeOptionsResolver = (trigger: Trigger, channelOptions?: Object) => Promise<ClientSubscribeOptions>;
export type PublishOptionsResolver = (trigger: Trigger, payload: any, channelOptions?: Object) => Promise<ClientPublishOptions>;
export type SubscribeHandler = (id: number, granted: Granted) => void;