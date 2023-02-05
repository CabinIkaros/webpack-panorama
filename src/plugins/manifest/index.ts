import HtmlWebpackPlugin from 'html-webpack-plugin';
import yaml, { FAILSAFE_SCHEMA } from 'js-yaml';
import { interpolateName } from 'loader-utils';
import path from 'path';
import { promisify } from 'util';
import webpack from 'webpack';
import ModuleDependency from 'webpack/lib/dependencies/ModuleDependency';
import { makePathsRelative } from 'webpack/lib/util/identifier';
import {
  DotaXmlEntry,
  ManifestEntry,
  ManifestEntryType,
  PanoramaManifestError,
  validateManifest,
} from './manifest';

export { ManifestEntry, ManifestEntryType, manifestSchema } from './manifest';

export const manifestTemplatePath = path.resolve(__dirname, '../../../manifest-template.ejs');

class PanoramaEntryDependency extends ModuleDependency {
  public get type() {
    return 'panorama entry';
  }
}

interface XmlAsset {
  file: string;
  type: string;
}

export interface PanoramaManifestPluginOptions extends HtmlWebpackPlugin.Options {
  entries: string | ManifestEntry[];
  dotaXmlList:DotaXmlEntry[]

  /**
   * @default '[path][name].[ext]'
   */
  entryFilename?: string;
}

const addEntry = promisify(webpack.Compilation.prototype.addEntry);

export class PanoramaManifestPlugin {
  private readonly entries: string | ManifestEntry[];
  private readonly xmlList?: DotaXmlEntry[];
  private readonly entryFilename: string;
  private readonly htmlWebpackPlugin: HtmlWebpackPlugin;
  private bManifestGenerated = false;
  constructor({ entries,dotaXmlList, entryFilename, ...options }: PanoramaManifestPluginOptions) {
    this.entries = entries;
    this.xmlList = dotaXmlList;
    this.entryFilename = entryFilename ?? '[path][name].[ext]';
    this.htmlWebpackPlugin = new HtmlWebpackPlugin({
      filename: 'custom_ui_manifest.xml',
      inject: false,
      template: manifestTemplatePath,
      xhtml: true,
      minify: false,
      ...options,
    });
  }

  public apply(compiler: webpack.Compiler) {
    compiler.options.entry = {};

    // @ts-ignore
    this.htmlWebpackPlugin.apply(compiler);

    compiler.hooks.compilation.tap(
      this.constructor.name,
      (compilation, { normalModuleFactory }) => {
        compilation.dependencyFactories.set(PanoramaEntryDependency, normalModuleFactory);
      },
    );

    compiler.hooks.make.tapPromise(this.constructor.name, async (compilation) => {
      let manifestName: string | undefined;
      let manifestContext: string;
      let entries: ManifestEntry[];
      if (typeof this.entries === 'string') {
        manifestName = makePathsRelative(compiler.context, this.entries);
        manifestContext = path.dirname(this.entries);

        compilation.fileDependencies.add(this.entries);

        const { inputFileSystem } = compiler;
        const readFile = promisify(inputFileSystem.readFile.bind(inputFileSystem));
        const rawManifest = (await readFile(this.entries))!.toString('utf8');

        try {
          if (/\.ya?ml$/.test(this.entries)) {
            entries = ((yaml.load(rawManifest, { schema: FAILSAFE_SCHEMA })) ?? []) as ManifestEntry[];
          } else if (this.entries.endsWith('.json')) {
            entries = JSON.parse(rawManifest);
          } else {
            throw new Error(`Unknown file extension '${path.extname(this.entries)}'`);
          }
        } catch (error) {
          // @ts-ignore
          compilation.errors.push(new PanoramaManifestError(error.message, manifestName));
          return;
        }
      } else {
        manifestContext = compiler.context;
        entries = this.entries;
      }

      try {
        validateManifest(entries, manifestName);
      } catch (error) {
        // @ts-ignore
        compilation.errors.push(error);
        return;
      }

      const entryModuleTypes = new Map<webpack.Module, ManifestEntryType>();
      await Promise.all(
        entries.map(async (entry) => {
          const name = entry.filename ?? entry.import;
          const filename =
            entry.filename ??
            (() => {
              const extension = module.userRequest.endsWith('.xml') ? 'xml' : 'js';
              return interpolateName(
                { resourcePath: module.userRequest },
                this.entryFilename.replace('[ext]', extension),
                { context: compiler.context },
              );
            });

          const dep = new PanoramaEntryDependency(entry.import);
          dep.loc = { name };
          await addEntry.call(compilation, manifestContext, dep, { name, filename });
          const module = compilation.moduleGraph.getModule(dep) as webpack.NormalModule;

          if (entry.type != null) {
            if (module.userRequest.endsWith('.xml')) {
              entryModuleTypes.set(module, entry.type);
            } else {
              compilation.errors.push(
                new PanoramaManifestError(
                  `JavaScript '${entry.import}' entry point should not have 'type'.`,
                  manifestName,
                ),
              );
            }
          }
        }),
      );

      // @ts-ignore
      const htmlHooks = HtmlWebpackPlugin.getHooks(compilation);

      htmlHooks.beforeAssetTagGeneration.tap(this.constructor.name, (args) => {
        const xmlAssets: XmlAsset[] = [];

        for (const [module, type] of entryModuleTypes) {
          for (const chunk of compilation.chunkGraph.getModuleChunksIterable(module)) {
            for (const file of chunk.files) {
              if (file.endsWith('.xml')) {
                  xmlAssets.push({ file: args.assets.publicPath + file, type });
              }
            }
          }
        }

        if (this.xmlList)
        {
          for (let xml of this.xmlList)
          {
            if (xml.path.endsWith('.xml'))
              if (xml.path.startsWith("file://"))
                xmlAssets.push({file: xml.path, type: xml.type});
          }
        }

        xmlAssets.sort((a, b) => {
          if (a.type > b.type) {
            return 1;
          }
          if (a.type < b.type) {
            return -1;
          }
          if (a.file > b.file) {
            return 1;
          }
          if (a.file < b.file) {
            return -1;
          }
          return 0;
        });

        (args.assets as any).xml = xmlAssets;

        return args;
      });
    });

    compiler.hooks.emit.tap(this.constructor.name, (compilation) => {
      for (const file in compilation.assets) {
        if (file == "custom_ui_manifest.xml") {
          if (this.bManifestGenerated == false) {
            this.bManifestGenerated = true;
          } else {
            delete compilation.assets[file];
            continue;
          }
        }
        if (file.endsWith('.xml')) {
          // @ts-ignore
          if (compilation.assets[file]._valueAsString == undefined) {
            delete compilation.assets[file];
          }
        }
      }
    });
  }
}
