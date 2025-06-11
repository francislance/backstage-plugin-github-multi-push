import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { githubMultiFilePush } from './actions/githubMultiFilePush';

export const scaffolderModule = createBackendModule({
    pluginId: 'scaffolder',
    moduleId: 'github-push-files',
    register(env) {
        env.registerInit({
            deps: {
                scaffolder: scaffolderActionsExtensionPoint,
                config: coreServices.rootConfig,
            },
            async init({ scaffolder, config }) {
                scaffolder.addActions(githubMultiFilePush({ config }));
            },
        });
    },
});
