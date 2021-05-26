/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import debug from 'debug'
import DubboCluster from './dubbo-cluster'
import Queue from './queue'
import { IRegistry } from '@apache/dubbo-registry'
import Context from './context'
import DubboUrl from './dubbo-url'
import { DubboScheduleError } from './err'
import DubboTcpTransport from './dubbo-tcp-transport'
import { DEFAULT_DUBBO_PROTOCOL_VERSION } from '@apache/dubbo-serialization'
import {
  Host,
  HostName,
  IDubboResponse,
  TDubboInterface,
  TDubboUrl
} from './types'

const log = debug('dubbo:scheduler')
const enum STATUS {
  PADDING = 'padding',
  READY = 'ready',
  FAILED = 'failded'
}

/**
 * scheduler
 * 1. subscribe registry
 * 2. subbscribe dubbo-cluster
 * 3. resolve queue reeust
 */
export default class Scheduler {
  private status: STATUS
  private queue: Queue
  private registry: IRegistry<any>
  private dubboCluster: DubboCluster
  private dubboServiceUrlMapper: Map<TDubboInterface, Array<DubboUrl>>

  constructor(registry: IRegistry<any>, queue: Queue) {
    log(`new scheduler`)
    this.status = STATUS.PADDING

    // init queue
    this.queue = queue
    this.queue.subscribe(this.handleQueueMessage)

    // init dubbo cluster
    this.dubboCluster = new DubboCluster()
    this.dubboCluster.subscribe({
      onConnect: this.handleDubboClusterConnect,
      onData: (data: any) => {
        this.handleTransportData(data)
      },
      onClose: this.handleTransportClose
    })

    // init registry
    this.registry = registry
    this.registry.subscribe({
      onData: this.handleRegistryServiceChange,
      onError: this.handleRegistryError
    })
  }

  static from(registry: IRegistry<any>, queue: Queue) {
    return new Scheduler(registry, queue)
  }

  /**
   * handle request in queue
   * @param ctx
   */
  private handleQueueMessage = (ctx: Context) => {
    log(`handle requestId %d, current status: %s`, ctx.requestId, this.status)

    switch (this.status) {
      case STATUS.READY:
        this.handleDubboInvoke(ctx)
        break
      case STATUS.PADDING:
        log('current scheduler was padding, please waiting...')
        break
      case STATUS.FAILED:
        this.queue.consume({
          requestId: ctx.requestId,
          err: new DubboScheduleError('registry occur fatal error')
        })
        break
      default:
        log('schedule unkown status')
    }
  }

  private handleRegistryServiceChange = (
    map: Map<TDubboInterface, Array<TDubboUrl>>
  ) => {
    log(`get all cluster info:=> %O`, map)
    const transportMap = new Map() as Map<HostName, Set<Host>>
    for (let [dubboInterface, dubboUrls] of map) {
      // if registry get dubbo url is empty,
      // but in memory dubbointerface map dubbo url is not empty
      // don't override it.
      if (
        dubboUrls.length === 0 &&
        this.dubboServiceUrlMapper.get(dubboInterface)
      ) {
        return
      }

      this.dubboServiceUrlMapper.set(
        dubboInterface,
        dubboUrls.map((dubboUrl) => {
          const url = DubboUrl.from(dubboUrl)
          const hostname = url.hostname
          const host = `${url.hostname}:${url.port}`
          if (transportMap.has(hostname)) {
            transportMap.get(hostname).add(host)
          } else {
            transportMap.set(hostname, new Set([host]))
          }
          return url
        })
      )
    }

    this.dubboCluster.setDubboClusterTransport(transportMap)
  }

  private handleRegistryError = (err: Error) => {
    log(err)
    if (this.status !== STATUS.READY) {
      this.status = STATUS.FAILED
    }
  }

  private handleDubboInvoke(ctx: Context) {
    const { requestId, dubboInterface, version, group } = ctx
    const hostnames = this.findDubboClusterByService(ctx)
    if (hostnames.size === 0) {
      this.queue.consume({
        requestId: ctx.requestId,
        err: new DubboScheduleError(
          `Could not find any agent worker with ${dubboInterface}`
        )
      })
      return
    }

    const transport = this.dubboCluster.getAvailableDubboTransport(hostnames)
    if (!transport) {
      this.queue.consume({
        requestId,
        err: new DubboScheduleError(
          `${dubboInterface}?grop=${group}&version=${version}`
        )
      })
      return
    }

    // send request
    this.sendRequest(ctx, transport)
  }

  private handleDubboClusterConnect = ({
    host,
    transport
  }: {
    host: string
    transport: DubboTcpTransport
  }) => {
    log('scheduler receive dubbo-tcp-transport connect %s', host)
    this.status = STATUS.READY
    const hostname = host.split(':')[0]
    for (let ctx of this.queue.requestQueue.values()) {
      if (ctx.wasInvoked && this.isHostCanResolveService(ctx, hostname)) {
        this.sendRequest(ctx, transport)
      }
    }
  }

  private sendRequest(ctx: Context, transport: DubboTcpTransport) {
    ctx.invokedByHost = transport.host
    const url = this.findDubboUrlByHost(ctx.dubboInterface, transport.host)
    ctx.request.dubboVersion =
      ctx.request.dubboVersion ||
      url.dubboVersion ||
      DEFAULT_DUBBO_PROTOCOL_VERSION
    ctx.request.path = url.path
    transport.write(ctx)
  }

  private handleTransportData = ({
    requestId,
    res,
    err,
    attachments
  }: IDubboResponse) => {
    this.queue.consume({
      requestId,
      res,
      err,
      attachments
    })
  }

  private handleTransportClose = (host: string) => {
    log(`dubbo-tcp-transport was close %s`, host)
    // search context by host in queue, re-dispatch
    const { requestQueue } = this.queue
    for (let [_, ctx] of requestQueue) {
      if (ctx.invokedByHost === host) {
        this.handleDubboInvoke(ctx)
      }
    }
  }

  private findDubboClusterByService(ctx: Context): Set<HostName> {
    const { dubboInterface, version, group } = ctx

    return this.dubboServiceUrlMapper
      .get(dubboInterface)
      .filter((url) => {
        // "*" refer to default wildcard in dubbo
        const isSameVersion =
          !version || version == '*' || url.version === version
        //如果Group为null，就默认匹配， 不检查group
        //如果Group不为null，确保group和接口的group一致
        const isSameGroup = !group || group === url.group
        return isSameGroup && isSameVersion
      })
      .reduce((reducer: Set<HostName>, prop: DubboUrl) => {
        reducer.add(prop.hostname)
        return reducer
      }, new Set())
  }

  private isHostCanResolveService(ctx: Context, hostname: string) {
    const hosts = this.findDubboClusterByService(ctx)
    return hosts.has(hostname)
  }

  private findDubboUrlByHost(dubboInterface: string, host: Host) {
    const [hostname, port] = host.split(':')
    const dubboUrls = this.dubboServiceUrlMapper.get(dubboInterface)
    return dubboUrls.find(
      (url) => url.hostname === hostname && url.port === Number(port)
    )
  }
}
