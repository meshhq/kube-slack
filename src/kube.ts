import * as fs from 'fs';
import * as config from 'config';
import * as Api from 'kubernetes-client';
import logger from './logger';
import {
	ConfigKube,
	KubernetesPod,
	KubernetesList,
	ContainerStatusWithPod,
	KubernetesPodMetrics,
} from './types';
import { flatten } from 'lodash';

export class Kubernetes {
	kube: Api.Api;
	genericClient: Api.Api;
	ready: Promise<any>;
	metricsEnabled: boolean;
	protected namespacesOnly: string[] | null = null;

	constructor() {
		this.kube = new Api.Client1_10({ config: this.getConfig() });
		this.genericClient = new (Api as any).Client({ config: this.getConfig() });
		this.ready = Promise.all([
			this.kube.loadSpec(),
			this.genericClient.loadSpec().catch(() => (this.metricsEnabled = false)),
		]);
		this.metricsEnabled = true;

		let namespacesOnly = config.get('namespaces_only') as string[] | string;
		if (namespacesOnly) {
			if (!Array.isArray(namespacesOnly)) {
				namespacesOnly = namespacesOnly
					.split(',')
					.map(namespace => namespace.trim()) as string[];
			}
			logger.info(
				`Watching pods the following namespaces: ${namespacesOnly.join(',')} .`
			);
			this.namespacesOnly = namespacesOnly;
		} else {
			logger.info(
				`KUBE_NAMESPACE_ONLY not set. Watching pods in ALL namespaces.`
			);
		}
	}

	getConfig() {
		let cfg = config.get('kube') as ConfigKube;
		if (cfg.kubeconfig) {
			return Api.config.fromKubeconfig();
		} else if (cfg.inCluster) {
			return Api.config.getInCluster();
		}

		// these keys are path to file
		let fileKey = ['ca', 'cert', 'key'];
		for (let key of fileKey) {
			if (cfg[key]) {
				cfg[key] = fs.readFileSync(cfg[key]);
			}
		}

		return cfg;
	}

	async getAllPodsInCluster(): Promise<KubernetesPod[]> {
		await this.ready;
		return this.kube.api.v1.pods.get().then(list => {
			return list.body.items;
		});
	}

	async getPodMetrics(
		pod: KubernetesPod
	): Promise<KubernetesPodMetrics | null> {
		if (!this.metricsEnabled) {
			return null;
		}

		await this.ready;

		if (this.genericClient.apis['metrics.k8s.io']) {
			let out = await this.genericClient.apis['metrics.k8s.io'].v1beta1
				.namespaces(pod.metadata.namespace)
				.pods(pod.metadata.name)
				.get();
			return out.body;
		} else {
			logger.warn('metrics.k8s.io not supported');
			this.metricsEnabled = false;
			return null;
		}
	}

	async getPodsInNamespace(namespace: string): Promise<KubernetesPod> {
		try {
			const podsListResult = await this.kube.api.v1
				.namespaces(namespace)
				.pods.get();
			return podsListResult.body.items;
		} catch (e) {
			logger.info(
				e,
				`Error while attempting to retrieve pods in namespace: ${namespace}. Does the namespace exist and did you set the correct permissions?`
			);

			throw e;
		}
	}

	protected async getPodsInWatchedNamespaces() {
		let namespacesOnly = this.namespacesOnly as string[];
		const arrOfArrOfPods: Array<KubernetesPod[] | Error> = await Promise.all(
			namespacesOnly.map(
				namespace => this.getPodsInNamespace(namespace).catch(e => e) // catch errors and simply return the Error object - we don't want the whole watch cycle to stop just because one of the namespaces couldn't watched.
			)
		);

		return flatten(arrOfArrOfPods.filter(
			podArrOrError => !(podArrOrError instanceof Error)
		) as KubernetesPod[][]); // filter out error from namespaces which failed get watched, the error has been already logged. TODO: notify on slack when a namespace could not be watched successfully.;
	}

	getWatchedPods() {
		return this.namespacesOnly
			? this.getPodsInWatchedNamespaces()
			: this.getAllPodsInCluster();
	}

	async getContainerStatuses() {
		let pods = await this.getWatchedPods();
		let out: ContainerStatusWithPod[] = [];
		for (let item of pods) {
			if (!item.status.containerStatuses) {
				continue;
			}
			for (let container of item.status.containerStatuses as any) {
				container.pod = item;
				out.push(container);
			}
		}
		return out;
	}
}

export default new Kubernetes();
