/// <reference path="..\compiler\commandLineParser.ts" />
/// <reference path="..\services\services.ts" />
/// <reference path="protocol.d.ts" />
/// <reference path="session.ts" />

namespace ts.server {
    export interface Logger {
        close(): void;
        isVerbose(): boolean;
        loggingEnabled(): boolean;
        perftrc(s: string): void;
        info(s: string): void;
        startGroup(): void;
        endGroup(): void;
        msg(s: string, type?: string): void;
    }

    const lineCollectionCapacity = 4;

    function mergeFormatOptions(formatCodeOptions: FormatCodeOptions, formatOptions: protocol.FormatOptions): void {
        const hasOwnProperty = Object.prototype.hasOwnProperty;
        Object.keys(formatOptions).forEach((key) => {
            const codeKey = key.charAt(0).toUpperCase() + key.substring(1);
            if (hasOwnProperty.call(formatCodeOptions, codeKey)) {
                formatCodeOptions[codeKey] = formatOptions[key];
            }
        });
    }

    export class ScriptInfo {
        svc: ScriptVersionCache;
        children: ScriptInfo[] = [];     // files referenced by this file
        defaultProject: Project;      // project to use by default for file
        fileWatcher: FileWatcher;
        formatCodeOptions = ts.clone(CompilerService.defaultFormatCodeOptions);
        path: Path;

        constructor(private host: ServerHost, public fileName: string, public content: string, public isOpen = false) {
            this.path = toPath(fileName, host.getCurrentDirectory(), createGetCanonicalFileName(host.useCaseSensitiveFileNames));
            this.svc = ScriptVersionCache.fromString(host, content);
        }

        setFormatOptions(formatOptions: protocol.FormatOptions): void {
            if (formatOptions) {
                mergeFormatOptions(this.formatCodeOptions, formatOptions);
            }
        }

        close() {
            this.isOpen = false;
        }

        addChild(childInfo: ScriptInfo) {
            this.children.push(childInfo);
        }

        snap() {
            return this.svc.getSnapshot();
        }

        getText() {
            const snap = this.snap();
            return snap.getText(0, snap.getLength());
        }

        getLineInfo(line: number) {
            const snap = this.snap();
            return snap.index.lineNumberToInfo(line);
        }

        editContent(start: number, end: number, newText: string): void {
            this.svc.edit(start, end - start, newText);
        }

        getTextChangeRangeBetweenVersions(startVersion: number, endVersion: number): ts.TextChangeRange {
            return this.svc.getTextChangesBetweenVersions(startVersion, endVersion);
        }

        getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
            return this.snap().getChangeRange(oldSnapshot);
        }
    }

    interface TimestampedResolvedModule extends ResolvedModuleWithFailedLookupLocations {
        lastCheckTime: number;
    }

    export class LSHost implements ts.LanguageServiceHost {
        ls: ts.LanguageService;
        compilationSettings: ts.CompilerOptions;
        filenameToScript: ts.FileMap<ScriptInfo>;
        roots: ScriptInfo[] = [];
        private resolvedModuleNames: ts.FileMap<Map<TimestampedResolvedModule>>;
        private moduleResolutionHost: ts.ModuleResolutionHost;
        private getCanonicalFileName: (fileName: string) => string;

        constructor(public host: ServerHost, public project: Project) {
            this.getCanonicalFileName = createGetCanonicalFileName(host.useCaseSensitiveFileNames);
            this.resolvedModuleNames = createFileMap<Map<TimestampedResolvedModule>>();
            this.filenameToScript = createFileMap<ScriptInfo>();
            this.moduleResolutionHost = {
                fileExists: fileName => this.fileExists(fileName),
                readFile: fileName => this.host.readFile(fileName),
                directoryExists: directoryName => this.host.directoryExists(directoryName)
            };
        }

        resolveModuleNames(moduleNames: string[], containingFile: string): ResolvedModule[] {
            const path = toPath(containingFile, this.host.getCurrentDirectory(), this.getCanonicalFileName);
            const currentResolutionsInFile = this.resolvedModuleNames.get(path);

            const newResolutions: Map<TimestampedResolvedModule> = {};
            const resolvedModules: ResolvedModule[] = [];

            const compilerOptions = this.getCompilationSettings();

            for (const moduleName of moduleNames) {
                // check if this is a duplicate entry in the list
                let resolution = lookUp(newResolutions, moduleName);
                if (!resolution) {
                    const existingResolution = currentResolutionsInFile && ts.lookUp(currentResolutionsInFile, moduleName);
                    if (moduleResolutionIsValid(existingResolution)) {
                        // ok, it is safe to use existing module resolution results  
                        resolution = existingResolution;
                    }
                    else {
                        resolution = <TimestampedResolvedModule>resolveModuleName(moduleName, containingFile, compilerOptions, this.moduleResolutionHost);
                        resolution.lastCheckTime = Date.now();
                        newResolutions[moduleName] = resolution;
                    }
                }

                ts.Debug.assert(resolution !== undefined);

                resolvedModules.push(resolution.resolvedModule);
            }

            // replace old results with a new one
            this.resolvedModuleNames.set(path, newResolutions);
            return resolvedModules;

            function moduleResolutionIsValid(resolution: TimestampedResolvedModule): boolean {
                if (!resolution) {
                    return false;
                }

                if (resolution.resolvedModule) {
                    // TODO: consider checking failedLookupLocations  
                    // TODO: use lastCheckTime to track expiration for module name resolution 
                    return true;
                }

                // consider situation if we have no candidate locations as valid resolution.
                // after all there is no point to invalidate it if we have no idea where to look for the module.
                return resolution.failedLookupLocations.length === 0;
            }
        }

        getDefaultLibFileName() {
            const nodeModuleBinDir = ts.getDirectoryPath(ts.normalizePath(this.host.getExecutingFilePath()));
            return ts.combinePaths(nodeModuleBinDir, ts.getDefaultLibFileName(this.compilationSettings));
        }

        getScriptSnapshot(filename: string): ts.IScriptSnapshot {
            const scriptInfo = this.getScriptInfo(filename);
            if (scriptInfo) {
                return scriptInfo.snap();
            }
        }

        setCompilationSettings(opt: ts.CompilerOptions) {
            this.compilationSettings = opt;
            // conservatively assume that changing compiler options might affect module resolution strategy
            this.resolvedModuleNames.clear();
        }

        lineAffectsRefs(filename: string, line: number) {
            const info = this.getScriptInfo(filename);
            const lineInfo = info.getLineInfo(line);
            if (lineInfo && lineInfo.text) {
                const regex = /reference|import|\/\*|\*\//;
                return regex.test(lineInfo.text);
            }
        }

        getCompilationSettings() {
            // change this to return active project settings for file
            return this.compilationSettings;
        }

        getScriptFileNames() {
            return this.roots.map(root => root.fileName);
        }

        getScriptVersion(filename: string) {
            return this.getScriptInfo(filename).svc.latestVersion().toString();
        }

        getCurrentDirectory(): string {
            return "";
        }

        getScriptIsOpen(filename: string) {
            return this.getScriptInfo(filename).isOpen;
        }

        removeReferencedFile(info: ScriptInfo) {
            if (!info.isOpen) {
                this.filenameToScript.remove(info.path);
                this.resolvedModuleNames.remove(info.path);
            }
        }

        getScriptInfo(filename: string): ScriptInfo {
            const path = toPath(filename, this.host.getCurrentDirectory(), this.getCanonicalFileName);
            let scriptInfo = this.filenameToScript.get(path);
            if (!scriptInfo) {
                scriptInfo = this.project.openReferencedFile(filename);
                if (scriptInfo) {
                    this.filenameToScript.set(path, scriptInfo);
                }
            }
            return scriptInfo;
        }

        addRoot(info: ScriptInfo) {
            if (!this.filenameToScript.contains(info.path)) {
                this.filenameToScript.set(info.path, info);
                this.roots.push(info);
            }
        }

        removeRoot(info: ScriptInfo) {
            if (!this.filenameToScript.contains(info.path)) {
                this.filenameToScript.remove(info.path);
                this.roots = copyListRemovingItem(info, this.roots);
                this.resolvedModuleNames.remove(info.path);
            }
        }

        saveTo(filename: string, tmpfilename: string) {
            const script = this.getScriptInfo(filename);
            if (script) {
                const snap = script.snap();
                this.host.writeFile(tmpfilename, snap.getText(0, snap.getLength()));
            }
        }

        reloadScript(filename: string, tmpfilename: string, cb: () => any) {
            const script = this.getScriptInfo(filename);
            if (script) {
                script.svc.reloadFromFile(tmpfilename, cb);
            }
        }

        editScript(filename: string, start: number, end: number, newText: string) {
            const script = this.getScriptInfo(filename);
            if (script) {
                script.editContent(start, end, newText);
                return;
            }

            throw new Error("No script with name '" + filename + "'");
        }

        resolvePath(path: string): string {
            const result = this.host.resolvePath(path);
            return result;
        }

        fileExists(path: string): boolean {
            const result = this.host.fileExists(path);
            return result;
        }

        directoryExists(path: string): boolean {
            return this.host.directoryExists(path);
        }

        /**
         *  @param line 1 based index
         */
        lineToTextSpan(filename: string, line: number): ts.TextSpan {
            const path = toPath(filename, this.host.getCurrentDirectory(), this.getCanonicalFileName);
            const script: ScriptInfo = this.filenameToScript.get(path);
            const index = script.snap().index;

            const lineInfo = index.lineNumberToInfo(line + 1);
            let len: number;
            if (lineInfo.leaf) {
                len = lineInfo.leaf.text.length;
            }
            else {
                const nextLineInfo = index.lineNumberToInfo(line + 2);
                len = nextLineInfo.offset - lineInfo.offset;
            }
            return ts.createTextSpan(lineInfo.offset, len);
        }

        /**
         * @param line 1 based index
         * @param offset 1 based index
         */
        lineOffsetToPosition(filename: string, line: number, offset: number): number {
            const path = toPath(filename, this.host.getCurrentDirectory(), this.getCanonicalFileName);
            const script: ScriptInfo = this.filenameToScript.get(path);
            const index = script.snap().index;

            const lineInfo = index.lineNumberToInfo(line);
            // TODO: assert this offset is actually on the line
            return (lineInfo.offset + offset - 1);
        }

        /**
         * @param line 1-based index
         * @param offset 1-based index
         */
        positionToLineOffset(filename: string, position: number): ILineInfo {
            const path = toPath(filename, this.host.getCurrentDirectory(), this.getCanonicalFileName);
            const script: ScriptInfo = this.filenameToScript.get(path);
            const index = script.snap().index;
            const lineOffset = index.charOffsetToLineNumberAndPos(position);
            return { line: lineOffset.line, offset: lineOffset.offset + 1 };
        }
    }

    export interface ProjectOptions {
        // these fields can be present in the project file
        files?: string[];
        compilerOptions?: ts.CompilerOptions;
    }

    export class Project {
        compilerService: CompilerService;
        projectFilename: string;
        projectFileWatcher: FileWatcher;
        directoryWatcher: FileWatcher;
        // Used to keep track of what directories are watched for this project
        directoriesWatchedForTsconfig: string[] = [];
        program: ts.Program;
        filenameToSourceFile: ts.Map<ts.SourceFile> = {};
        updateGraphSeq = 0;
        /** Used for configured projects which may have multiple open roots */
        openRefCount = 0;

        constructor(public projectService: ProjectService, public projectOptions?: ProjectOptions) {
            if (projectOptions && projectOptions.files) {
                // If files are listed explicitly, allow all extensions
                projectOptions.compilerOptions.allowNonTsExtensions = true;
            }
            this.compilerService = new CompilerService(this, projectOptions && projectOptions.compilerOptions);
        }

        addOpenRef() {
            this.openRefCount++;
        }

        deleteOpenRef() {
            this.openRefCount--;
            return this.openRefCount;
        }

        openReferencedFile(filename: string) {
            return this.projectService.openFile(filename, /*openedByClient*/ false);
        }

        getRootFiles() {
            return this.compilerService.host.roots.map(info => info.fileName);
        }

        getFileNames() {
            const sourceFiles = this.program.getSourceFiles();
            return sourceFiles.map(sourceFile => sourceFile.fileName);
        }

        getSourceFile(info: ScriptInfo) {
            return this.filenameToSourceFile[info.fileName];
        }

        getSourceFileFromName(filename: string, requireOpen?: boolean) {
            const info = this.projectService.getScriptInfo(filename);
            if (info) {
                if ((!requireOpen) || info.isOpen) {
                    return this.getSourceFile(info);
                }
            }
        }

        isRoot(info: ScriptInfo) {
            return this.compilerService.host.roots.some(root => root === info);
        }

        removeReferencedFile(info: ScriptInfo) {
            this.compilerService.host.removeReferencedFile(info);
            this.updateGraph();
        }

        updateFileMap() {
            this.filenameToSourceFile = {};
            const sourceFiles = this.program.getSourceFiles();
            for (let i = 0, len = sourceFiles.length; i < len; i++) {
                const normFilename = ts.normalizePath(sourceFiles[i].fileName);
                this.filenameToSourceFile[normFilename] = sourceFiles[i];
            }
        }

        finishGraph() {
            this.updateGraph();
            this.compilerService.languageService.getNavigateToItems(".*");
        }

        updateGraph() {
            this.program = this.compilerService.languageService.getProgram();
            this.updateFileMap();
        }

        isConfiguredProject() {
            return this.projectFilename;
        }

        // add a root file to project
        addRoot(info: ScriptInfo) {
            this.compilerService.host.addRoot(info);
        }

        // remove a root file from project
        removeRoot(info: ScriptInfo) {
            this.compilerService.host.removeRoot(info);
        }

        filesToString() {
            let strBuilder = "";
            ts.forEachValue(this.filenameToSourceFile,
                sourceFile => { strBuilder += sourceFile.fileName + "\n"; });
            return strBuilder;
        }

        setProjectOptions(projectOptions: ProjectOptions) {
            this.projectOptions = projectOptions;
            if (projectOptions.compilerOptions) {
                projectOptions.compilerOptions.allowNonTsExtensions = true;
                this.compilerService.setCompilerOptions(projectOptions.compilerOptions);
            }
        }
    }

    export interface ProjectOpenResult {
        success?: boolean;
        errorMsg?: string;
        project?: Project;
    }

    function copyListRemovingItem<T>(item: T, list: T[]) {
        const copiedList: T[] = [];
        for (let i = 0, len = list.length; i < len; i++) {
            if (list[i] != item) {
                copiedList.push(list[i]);
            }
        }
        return copiedList;
    }

    export interface ProjectServiceEventHandler {
        (eventName: string, project: Project, fileName: string): void;
    }

    export interface HostConfiguration {
        formatCodeOptions: ts.FormatCodeOptions;
        hostInfo: string;
    }

    export class ProjectService {
        filenameToScriptInfo: ts.Map<ScriptInfo> = {};
        // open, non-configured root files
        openFileRoots: ScriptInfo[] = [];
        // projects built from openFileRoots
        inferredProjects: Project[] = [];
        // projects specified by a tsconfig.json file
        configuredProjects: Project[] = [];
        // open files referenced by a project
        openFilesReferenced: ScriptInfo[] = [];
        // open files that are roots of a configured project
        openFileRootsConfigured: ScriptInfo[] = [];
        // a path to directory watcher map that detects added tsconfig files
        directoryWatchersForTsconfig: ts.Map<FileWatcher> = {};
        // count of how many projects are using the directory watcher. If the 
        // number becomes 0 for a watcher, then we should close it.
        directoryWatchersRefCount: ts.Map<number> = {};
        hostConfiguration: HostConfiguration;
        timerForDetectingProjectFileListChanges: Map<NodeJS.Timer> = {};

        constructor(public host: ServerHost, public psLogger: Logger, public eventHandler?: ProjectServiceEventHandler) {
            // ts.disableIncrementalParsing = true;
            this.addDefaultHostConfiguration();
        }

        addDefaultHostConfiguration() {
            this.hostConfiguration = {
                formatCodeOptions: ts.clone(CompilerService.defaultFormatCodeOptions),
                hostInfo: "Unknown host"
            };
        }

        getFormatCodeOptions(file?: string) {
            if (file) {
                const info = this.filenameToScriptInfo[file];
                if (info) {
                    return info.formatCodeOptions;
                }
            }
            return this.hostConfiguration.formatCodeOptions;
        }

        watchedFileChanged(fileName: string) {
            const info = this.filenameToScriptInfo[fileName];
            if (!info) {
                this.psLogger.info("Error: got watch notification for unknown file: " + fileName);
            }

            if (!this.host.fileExists(fileName)) {
                // File was deleted
                this.fileDeletedInFilesystem(info);
            }
            else {
                if (info && (!info.isOpen)) {
                    info.svc.reloadFromFile(info.fileName);
                }
            }
        }

        /**
         * This is the callback function when a watched directory has added or removed source code files.
         * @param project the project that associates with this directory watcher
         * @param fileName the absolute file name that changed in watched directory
         */
        directoryWatchedForSourceFilesChanged(project: Project, fileName: string) {
            // If a change was made inside "folder/file", node will trigger the callback twice:
            // one with the fileName being "folder/file", and the other one with "folder".
            // We don't respond to the second one.
            if (fileName && !ts.isSupportedSourceFileName(fileName, project.projectOptions ? project.projectOptions.compilerOptions : undefined)) {
                return;
            }

            this.log("Detected source file changes: " + fileName);
            this.startTimerForDetectingProjectFileListChanges(project);
        }

        startTimerForDetectingProjectFileListChanges(project: Project) {
            if (this.timerForDetectingProjectFileListChanges[project.projectFilename]) {
                clearTimeout(this.timerForDetectingProjectFileListChanges[project.projectFilename]);
            }
            this.timerForDetectingProjectFileListChanges[project.projectFilename] = setTimeout(
                () => this.handleProjectFileListChanges(project),
                250
            );
        }

        handleProjectFileListChanges(project: Project) {
            const { projectOptions } = this.configFileToProjectOptions(project.projectFilename);

            const newRootFiles = projectOptions.files.map((f => this.getCanonicalFileName(f)));
            const currentRootFiles = project.getRootFiles().map((f => this.getCanonicalFileName(f)));

            // We check if the project file list has changed. If so, we update the project.
            if (!arrayIsEqualTo(currentRootFiles && currentRootFiles.sort(), newRootFiles && newRootFiles.sort())) {
                // For configured projects, the change is made outside the tsconfig file, and
                // it is not likely to affect the project for other files opened by the client. We can 
                // just update the current project.
                this.updateConfiguredProject(project);

                // Call updateProjectStructure to clean up inferred projects we may have 
                // created for the new files
                this.updateProjectStructure();
            }
        }

        /**
         * This is the callback function when a watched directory has an added tsconfig file.
         */
        directoryWatchedForTsconfigChanged(fileName: string) {
            if (ts.getBaseFileName(fileName) != "tsconfig.json") {
                this.log(fileName + " is not tsconfig.json");
                return;
            }

            this.log("Detected newly added tsconfig file: " + fileName);

            const { projectOptions } = this.configFileToProjectOptions(fileName);

            const rootFilesInTsconfig = projectOptions.files.map(f => this.getCanonicalFileName(f));
            const openFileRoots = this.openFileRoots.map(s => this.getCanonicalFileName(s.fileName));

            // We should only care about the new tsconfig file if it contains any
            // opened root files of existing inferred projects
            for (const openFileRoot of openFileRoots) {
                if (rootFilesInTsconfig.indexOf(openFileRoot) >= 0) {
                    this.reloadProjects();
                    return;
                }
            }
        }

        getCanonicalFileName(fileName: string) {
            const name = this.host.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
            return ts.normalizePath(name);
        }

        watchedProjectConfigFileChanged(project: Project) {
            this.log("Config file changed: " + project.projectFilename);
            this.updateConfiguredProject(project);
            this.updateProjectStructure();
        }

        log(msg: string, type = "Err") {
            this.psLogger.msg(msg, type);
        }

        setHostConfiguration(args: ts.server.protocol.ConfigureRequestArguments) {
            if (args.file) {
                const info = this.filenameToScriptInfo[args.file];
                if (info) {
                    info.setFormatOptions(args.formatOptions);
                    this.log("Host configuration update for file " + args.file, "Info");
                }
            }
            else {
                if (args.hostInfo !== undefined) {
                    this.hostConfiguration.hostInfo = args.hostInfo;
                    this.log("Host information " + args.hostInfo, "Info");
                }
                if (args.formatOptions) {
                    mergeFormatOptions(this.hostConfiguration.formatCodeOptions, args.formatOptions);
                    this.log("Format host information updated", "Info");
                }
            }
        }

        closeLog() {
            this.psLogger.close();
        }

        createInferredProject(root: ScriptInfo) {
            const project = new Project(this);
            project.addRoot(root);

            let currentPath = ts.getDirectoryPath(root.fileName);
            let parentPath = ts.getDirectoryPath(currentPath);
            while (currentPath != parentPath) {
                if (!project.projectService.directoryWatchersForTsconfig[currentPath]) {
                    this.log("Add watcher for: " + currentPath);
                    project.projectService.directoryWatchersForTsconfig[currentPath] =
                        this.host.watchDirectory(currentPath, fileName => this.directoryWatchedForTsconfigChanged(fileName));
                    project.projectService.directoryWatchersRefCount[currentPath] = 1;
                }
                else {
                    project.projectService.directoryWatchersRefCount[currentPath] += 1;
                }
                project.directoriesWatchedForTsconfig.push(currentPath);
                currentPath = parentPath;
                parentPath = ts.getDirectoryPath(parentPath);
            }

            project.finishGraph();
            this.inferredProjects.push(project);
            return project;
        }

        fileDeletedInFilesystem(info: ScriptInfo) {
            this.psLogger.info(info.fileName + " deleted");

            if (info.fileWatcher) {
                info.fileWatcher.close();
                info.fileWatcher = undefined;
            }

            if (!info.isOpen) {
                this.filenameToScriptInfo[info.fileName] = undefined;
                const referencingProjects = this.findReferencingProjects(info);
                if (info.defaultProject) {
                    info.defaultProject.removeRoot(info);
                }
                for (let i = 0, len = referencingProjects.length; i < len; i++) {
                    referencingProjects[i].removeReferencedFile(info);
                }
                for (let j = 0, flen = this.openFileRoots.length; j < flen; j++) {
                    const openFile = this.openFileRoots[j];
                    if (this.eventHandler) {
                        this.eventHandler("context", openFile.defaultProject, openFile.fileName);
                    }
                }
                for (let j = 0, flen = this.openFilesReferenced.length; j < flen; j++) {
                    const openFile = this.openFilesReferenced[j];
                    if (this.eventHandler) {
                        this.eventHandler("context", openFile.defaultProject, openFile.fileName);
                    }
                }
            }

            this.printProjects();
        }

        updateConfiguredProjectList() {
            const configuredProjects: Project[] = [];
            for (let i = 0, len = this.configuredProjects.length; i < len; i++) {
                if (this.configuredProjects[i].openRefCount > 0) {
                    configuredProjects.push(this.configuredProjects[i]);
                }
            }
            this.configuredProjects = configuredProjects;
        }

        removeProject(project: Project) {
            this.log("remove project: " + project.getRootFiles().toString());
            if (project.isConfiguredProject()) {
                project.projectFileWatcher.close();
                project.directoryWatcher.close();
                this.configuredProjects = copyListRemovingItem(project, this.configuredProjects);
            }
            else {
                for (const directory of project.directoriesWatchedForTsconfig) {
                    // if the ref count for this directory watcher drops to 0, it's time to close it
                    project.projectService.directoryWatchersRefCount[directory]--;
                    if (!project.projectService.directoryWatchersRefCount[directory]) {
                        this.log("Close directory watcher for: " + directory);
                        project.projectService.directoryWatchersForTsconfig[directory].close();
                        delete project.projectService.directoryWatchersForTsconfig[directory];
                    }
                }
                this.inferredProjects = copyListRemovingItem(project, this.inferredProjects);
            }

            const fileNames = project.getFileNames();
            for (const fileName of fileNames) {
                const info = this.getScriptInfo(fileName);
                if (info.defaultProject == project) {
                    info.defaultProject = undefined;
                }
            }
        }

        setConfiguredProjectRoot(info: ScriptInfo) {
            for (let i = 0, len = this.configuredProjects.length; i < len; i++) {
                const configuredProject = this.configuredProjects[i];
                if (configuredProject.isRoot(info)) {
                    info.defaultProject = configuredProject;
                    configuredProject.addOpenRef();
                    return true;
                }
            }
            return false;
        }

        addOpenFile(info: ScriptInfo) {
            if (this.setConfiguredProjectRoot(info)) {
                this.openFileRootsConfigured.push(info);
            }
            else {
                this.findReferencingProjects(info);
                if (info.defaultProject) {
                    this.openFilesReferenced.push(info);
                }
                else {
                    // create new inferred project p with the newly opened file as root
                    info.defaultProject = this.createInferredProject(info);
                    const openFileRoots: ScriptInfo[] = [];
                    // for each inferred project root r
                    for (let i = 0, len = this.openFileRoots.length; i < len; i++) {
                        const r = this.openFileRoots[i];
                        // if r referenced by the new project
                        if (info.defaultProject.getSourceFile(r)) {
                            // remove project rooted at r
                            this.removeProject(r.defaultProject);
                            // put r in referenced open file list
                            this.openFilesReferenced.push(r);
                            // set default project of r to the new project
                            r.defaultProject = info.defaultProject;
                        }
                        else {
                            // otherwise, keep r as root of inferred project
                            openFileRoots.push(r);
                        }
                    }
                    this.openFileRoots = openFileRoots;
                    this.openFileRoots.push(info);
                }
            }
            this.updateConfiguredProjectList();
        }

        /**
          * Remove this file from the set of open, non-configured files.
          * @param info The file that has been closed or newly configured
          */
        closeOpenFile(info: ScriptInfo) {
            // Closing file should trigger re-reading the file content from disk. This is 
            // because the user may chose to discard the buffer content before saving 
            // to the disk, and the server's version of the file can be out of sync.
            info.svc.reloadFromFile(info.fileName);

            const openFileRoots: ScriptInfo[] = [];
            let removedProject: Project;
            for (let i = 0, len = this.openFileRoots.length; i < len; i++) {
                // if closed file is root of project
                if (info === this.openFileRoots[i]) {
                    // remove that project and remember it
                    removedProject = info.defaultProject;
                }
                else {
                    openFileRoots.push(this.openFileRoots[i]);
                }
            }
            this.openFileRoots = openFileRoots;
            if (!removedProject) {
                const openFileRootsConfigured: ScriptInfo[] = [];

                for (let i = 0, len = this.openFileRootsConfigured.length; i < len; i++) {
                    if (info === this.openFileRootsConfigured[i]) {
                        if (info.defaultProject.deleteOpenRef() === 0) {
                            removedProject = info.defaultProject;
                        }
                    }
                    else {
                        openFileRootsConfigured.push(this.openFileRootsConfigured[i]);
                    }
                }

                this.openFileRootsConfigured = openFileRootsConfigured;
            }
            if (removedProject) {
                this.removeProject(removedProject);
                const openFilesReferenced: ScriptInfo[] = [];
                const orphanFiles: ScriptInfo[] = [];
                // for all open, referenced files f
                for (let i = 0, len = this.openFilesReferenced.length; i < len; i++) {
                    const f = this.openFilesReferenced[i];
                    // if f was referenced by the removed project, remember it
                    if (f.defaultProject === removedProject || !f.defaultProject) {
                        f.defaultProject = undefined;
                        orphanFiles.push(f);
                    }
                    else {
                        // otherwise add it back to the list of referenced files
                        openFilesReferenced.push(f);
                    }
                }
                this.openFilesReferenced = openFilesReferenced;
                // treat orphaned files as newly opened
                for (let i = 0, len = orphanFiles.length; i < len; i++) {
                    this.addOpenFile(orphanFiles[i]);
                }
            }
            else {
                this.openFilesReferenced = copyListRemovingItem(info, this.openFilesReferenced);
            }
            info.close();
        }

        findReferencingProjects(info: ScriptInfo, excludedProject?: Project) {
            const referencingProjects: Project[] = [];
            info.defaultProject = undefined;
            for (let i = 0, len = this.inferredProjects.length; i < len; i++) {
                const inferredProject = this.inferredProjects[i];
                inferredProject.updateGraph();
                if (inferredProject !== excludedProject) {
                    if (inferredProject.getSourceFile(info)) {
                        info.defaultProject = inferredProject;
                        referencingProjects.push(inferredProject);
                    }
                }
            }
            for (let i = 0, len = this.configuredProjects.length; i < len; i++) {
                const configuredProject = this.configuredProjects[i];
                configuredProject.updateGraph();
                if (configuredProject.getSourceFile(info)) {
                    info.defaultProject = configuredProject;
                }
            }
            return referencingProjects;
        }

        /**
         * This function rebuilds the project for every file opened by the client
         */
        reloadProjects() {
            this.log("reload projects.");
            // First check if there is new tsconfig file added for inferred project roots
            for (const info of this.openFileRoots) {
                this.openOrUpdateConfiguredProjectForFile(info.fileName);
            }
            this.updateProjectStructure();
        }

        /**
         * This function is to update the project structure for every projects. 
         * It is called on the premise that all the configured projects are 
         * up to date.
         */
        updateProjectStructure() {
            this.log("updating project structure from ...", "Info");
            this.printProjects();

            const unattachedOpenFiles: ScriptInfo[] = [];
            const openFileRootsConfigured: ScriptInfo[] = [];
            for (const info of this.openFileRootsConfigured) {
                const project = info.defaultProject;
                if (!project || !(project.getSourceFile(info))) {
                    info.defaultProject = undefined;
                    unattachedOpenFiles.push(info);
                }
                else {
                    openFileRootsConfigured.push(info);
                }
            }
            this.openFileRootsConfigured = openFileRootsConfigured;

            // First loop through all open files that are referenced by projects but are not
            // project roots.  For each referenced file, see if the default project still
            // references that file.  If so, then just keep the file in the referenced list.
            // If not, add the file to an unattached list, to be rechecked later.
            const openFilesReferenced: ScriptInfo[] = [];
            for (let i = 0, len = this.openFilesReferenced.length; i < len; i++) {
                const referencedFile = this.openFilesReferenced[i];
                referencedFile.defaultProject.updateGraph();
                const sourceFile = referencedFile.defaultProject.getSourceFile(referencedFile);
                if (sourceFile) {
                    openFilesReferenced.push(referencedFile);
                }
                else {
                    unattachedOpenFiles.push(referencedFile);
                }
            }
            this.openFilesReferenced = openFilesReferenced;

            // Then, loop through all of the open files that are project roots.
            // For each root file, note the project that it roots.  Then see if
            // any other projects newly reference the file.  If zero projects
            // newly reference the file, keep it as a root.  If one or more
            // projects newly references the file, remove its project from the
            // inferred projects list (since it is no longer a root) and add
            // the file to the open, referenced file list.
            const openFileRoots: ScriptInfo[] = [];
            for (let i = 0, len = this.openFileRoots.length; i < len; i++) {
                const rootFile = this.openFileRoots[i];
                const rootedProject = rootFile.defaultProject;
                const referencingProjects = this.findReferencingProjects(rootFile, rootedProject);

                if (rootFile.defaultProject && rootFile.defaultProject.isConfiguredProject()) {
                    // If the root file has already been added into a configured project,
                    // meaning the original inferred project is gone already. 
                    if (!rootedProject.isConfiguredProject()) {
                        this.removeProject(rootedProject);
                    }
                    this.openFileRootsConfigured.push(rootFile);
                }
                else {
                    if (referencingProjects.length === 0) {
                        rootFile.defaultProject = rootedProject;
                        openFileRoots.push(rootFile);
                    }
                    else {
                        // remove project from inferred projects list because root captured
                        this.removeProject(rootedProject);
                        this.openFilesReferenced.push(rootFile);
                    }
                }
            }
            this.openFileRoots = openFileRoots;

            // Finally, if we found any open, referenced files that are no longer
            // referenced by their default project, treat them as newly opened
            // by the editor.
            for (let i = 0, len = unattachedOpenFiles.length; i < len; i++) {
                this.addOpenFile(unattachedOpenFiles[i]);
            }
            this.printProjects();
        }

        getScriptInfo(filename: string) {
            filename = ts.normalizePath(filename);
            return ts.lookUp(this.filenameToScriptInfo, filename);
        }

        /**
         * @param filename is absolute pathname
         * @param fileContent is a known version of the file content that is more up to date than the one on disk
         */
        openFile(fileName: string, openedByClient: boolean, fileContent?: string) {
            fileName = ts.normalizePath(fileName);
            let info = ts.lookUp(this.filenameToScriptInfo, fileName);
            if (!info) {
                let content: string;
                if (this.host.fileExists(fileName)) {
                    content = fileContent || this.host.readFile(fileName);
                }
                if (!content) {
                    if (openedByClient) {
                        content = "";
                    }
                }
                if (content !== undefined) {
                    info = new ScriptInfo(this.host, fileName, content, openedByClient);
                    info.setFormatOptions(this.getFormatCodeOptions());
                    this.filenameToScriptInfo[fileName] = info;
                    if (!info.isOpen) {
                        info.fileWatcher = this.host.watchFile(fileName, _ => { this.watchedFileChanged(fileName); });
                    }
                }
            }
            if (info) {
                if (fileContent) {
                    info.svc.reload(fileContent);
                }
                if (openedByClient) {
                    info.isOpen = true;
                }
            }
            return info;
        }

        // This is different from the method the compiler uses because
        // the compiler can assume it will always start searching in the
        // current directory (the directory in which tsc was invoked).
        // The server must start searching from the directory containing
        // the newly opened file.
        findConfigFile(searchPath: string): string {
            while (true) {
                const fileName = ts.combinePaths(searchPath, "tsconfig.json");
                if (this.host.fileExists(fileName)) {
                    return fileName;
                }
                const parentPath = ts.getDirectoryPath(searchPath);
                if (parentPath === searchPath) {
                    break;
                }
                searchPath = parentPath;
            }
            return undefined;
        }

        /**
         * Open file whose contents is managed by the client
         * @param filename is absolute pathname
         * @param fileContent is a known version of the file content that is more up to date than the one on disk
         */
        openClientFile(fileName: string, fileContent?: string) {
            this.openOrUpdateConfiguredProjectForFile(fileName);
            const info = this.openFile(fileName, /*openedByClient*/ true, fileContent);
            this.addOpenFile(info);
            this.printProjects();
            return info;
        }

        /**
         * This function tries to search for a tsconfig.json for the given file. If we found it, 
         * we first detect if there is already a configured project created for it: if so, we re-read
         * the tsconfig file content and update the project; otherwise we create a new one. 
         */
        openOrUpdateConfiguredProjectForFile(fileName: string) {
            const searchPath = ts.normalizePath(getDirectoryPath(fileName));
            this.log("Search path: " + searchPath, "Info");
            const configFileName = this.findConfigFile(searchPath);
            if (configFileName) {
                this.log("Config file name: " + configFileName, "Info");
                const project = this.findConfiguredProjectByConfigFile(configFileName);
                if (!project) {
                    const configResult = this.openConfigFile(configFileName, fileName);
                    if (!configResult.success) {
                        this.log("Error opening config file " + configFileName + " " + configResult.errorMsg);
                    }
                    else {
                        this.log("Opened configuration file " + configFileName, "Info");
                        this.configuredProjects.push(configResult.project);
                    }
                }
                else {
                    this.updateConfiguredProject(project);
                }
            }
            else {
                this.log("No config files found.");
            }
        }

        /**
         * Close file whose contents is managed by the client
         * @param filename is absolute pathname
         */
        closeClientFile(filename: string) {
            const info = ts.lookUp(this.filenameToScriptInfo, filename);
            if (info) {
                this.closeOpenFile(info);
                info.isOpen = false;
            }
            this.printProjects();
        }

        getProjectForFile(filename: string) {
            const scriptInfo = ts.lookUp(this.filenameToScriptInfo, filename);
            if (scriptInfo) {
                return scriptInfo.defaultProject;
            }
        }

        printProjectsForFile(filename: string) {
            const scriptInfo = ts.lookUp(this.filenameToScriptInfo, filename);
            if (scriptInfo) {
                this.psLogger.startGroup();
                this.psLogger.info("Projects for " + filename);
                const projects = this.findReferencingProjects(scriptInfo);
                for (let i = 0, len = projects.length; i < len; i++) {
                    this.psLogger.info("Project " + i.toString());
                }
                this.psLogger.endGroup();
            }
            else {
                this.psLogger.info(filename + " not in any project");
            }
        }

        printProjects() {
            if (!this.psLogger.isVerbose()) {
                return;
            }
            this.psLogger.startGroup();
            for (let i = 0, len = this.inferredProjects.length; i < len; i++) {
                const project = this.inferredProjects[i];
                project.updateGraph();
                this.psLogger.info("Project " + i.toString());
                this.psLogger.info(project.filesToString());
                this.psLogger.info("-----------------------------------------------");
            }
            for (let i = 0, len = this.configuredProjects.length; i < len; i++) {
                const project = this.configuredProjects[i];
                project.updateGraph();
                this.psLogger.info("Project (configured) " + (i + this.inferredProjects.length).toString());
                this.psLogger.info(project.filesToString());
                this.psLogger.info("-----------------------------------------------");
            }
            this.psLogger.info("Open file roots of inferred projects: ");
            for (let i = 0, len = this.openFileRoots.length; i < len; i++) {
                this.psLogger.info(this.openFileRoots[i].fileName);
            }
            this.psLogger.info("Open files referenced by inferred or configured projects: ");
            for (let i = 0, len = this.openFilesReferenced.length; i < len; i++) {
                let fileInfo = this.openFilesReferenced[i].fileName;
                if (this.openFilesReferenced[i].defaultProject.isConfiguredProject()) {
                    fileInfo += " (configured)";
                }
                this.psLogger.info(fileInfo);
            }
            this.psLogger.info("Open file roots of configured projects: ");
            for (let i = 0, len = this.openFileRootsConfigured.length; i < len; i++) {
                this.psLogger.info(this.openFileRootsConfigured[i].fileName);
            }
            this.psLogger.endGroup();
        }

        configProjectIsActive(fileName: string) {
            return this.findConfiguredProjectByConfigFile(fileName) === undefined;
        }

        findConfiguredProjectByConfigFile(configFileName: string) {
            for (let i = 0, len = this.configuredProjects.length; i < len; i++) {
                if (this.configuredProjects[i].projectFilename == configFileName) {
                    return this.configuredProjects[i];
                }
            }
            return undefined;
        }

        configFileToProjectOptions(configFilename: string): { succeeded: boolean, projectOptions?: ProjectOptions, error?: ProjectOpenResult } {
            configFilename = ts.normalizePath(configFilename);
            // file references will be relative to dirPath (or absolute)
            const dirPath = ts.getDirectoryPath(configFilename);
            const contents = this.host.readFile(configFilename);
            const rawConfig: { config?: ProjectOptions; error?: Diagnostic; } = ts.parseConfigFileTextToJson(configFilename, contents);
            if (rawConfig.error) {
                return { succeeded: false, error: rawConfig.error };
            }
            else {
                const parsedCommandLine = ts.parseJsonConfigFileContent(rawConfig.config, this.host, dirPath);
                Debug.assert(!!parsedCommandLine.fileNames);

                if (parsedCommandLine.errors && (parsedCommandLine.errors.length > 0)) {
                    return { succeeded: false, error: { errorMsg: "tsconfig option errors" } };
                }
                else if (parsedCommandLine.fileNames.length === 0) {
                    return { succeeded: false, error: { errorMsg: "no files found" } };
                }
                else {
                    const projectOptions: ProjectOptions = {
                        files: parsedCommandLine.fileNames,
                        compilerOptions: parsedCommandLine.options
                    };
                    return { succeeded: true, projectOptions };
                }
            }

        }

        openConfigFile(configFilename: string, clientFileName?: string): ProjectOpenResult {
            const { succeeded, projectOptions, error } = this.configFileToProjectOptions(configFilename);
            if (!succeeded) {
                return error;
            }
            else {
                const project = this.createProject(configFilename, projectOptions);
                for (const rootFilename of projectOptions.files) {
                    if (this.host.fileExists(rootFilename)) {
                        const info = this.openFile(rootFilename, /*openedByClient*/ clientFileName == rootFilename);
                        project.addRoot(info);
                    }
                    else {
                        return { errorMsg: "specified file " + rootFilename + " not found" };
                    }
                }
                project.finishGraph();
                project.projectFileWatcher = this.host.watchFile(configFilename, _ => this.watchedProjectConfigFileChanged(project));
                this.log("Add recursive watcher for: " + ts.getDirectoryPath(configFilename));
                project.directoryWatcher = this.host.watchDirectory(
                    ts.getDirectoryPath(configFilename),
                    path => this.directoryWatchedForSourceFilesChanged(project, path),
                    /*recursive*/ true
                );
                return { success: true, project: project };
            }
        }

        updateConfiguredProject(project: Project) {
            if (!this.host.fileExists(project.projectFilename)) {
                this.log("Config file deleted");
                this.removeProject(project);
            }
            else {
                const { succeeded, projectOptions, error } = this.configFileToProjectOptions(project.projectFilename);
                if (!succeeded) {
                    return error;
                }
                else {
                    const oldFileNames = project.compilerService.host.roots.map(info => info.fileName);
                    const newFileNames = projectOptions.files;
                    const fileNamesToRemove = oldFileNames.filter(f => newFileNames.indexOf(f) < 0);
                    const fileNamesToAdd = newFileNames.filter(f => oldFileNames.indexOf(f) < 0);

                    for (const fileName of fileNamesToRemove) {
                        const info = this.getScriptInfo(fileName);
                        if (info) {
                            project.removeRoot(info);
                        }
                    }

                    for (const fileName of fileNamesToAdd) {
                        let info = this.getScriptInfo(fileName);
                        if (!info) {
                            info = this.openFile(fileName, /*openedByClient*/ false);
                        }
                        else {
                            // if the root file was opened by client, it would belong to either 
                            // openFileRoots or openFileReferenced.
                            if (info.isOpen) {
                                if (this.openFileRoots.indexOf(info) >= 0) {
                                    this.openFileRoots = copyListRemovingItem(info, this.openFileRoots);
                                    if (info.defaultProject && !info.defaultProject.isConfiguredProject()) {
                                        this.removeProject(info.defaultProject);
                                    }
                                }
                                if (this.openFilesReferenced.indexOf(info) >= 0) {
                                    this.openFilesReferenced = copyListRemovingItem(info, this.openFilesReferenced);
                                }
                                this.openFileRootsConfigured.push(info);
                                info.defaultProject = project;
                            }
                        }
                        project.addRoot(info);
                    }

                    project.setProjectOptions(projectOptions);
                    project.finishGraph();
                }
            }
        }

        createProject(projectFilename: string, projectOptions?: ProjectOptions) {
            const project = new Project(this, projectOptions);
            project.projectFilename = projectFilename;
            return project;
        }

    }

    export class CompilerService {
        host: LSHost;
        languageService: ts.LanguageService;
        classifier: ts.Classifier;
        settings: ts.CompilerOptions;
        documentRegistry = ts.createDocumentRegistry();

        constructor(public project: Project, opt?: ts.CompilerOptions) {
            this.host = new LSHost(project.projectService.host, project);
            if (opt) {
                this.setCompilerOptions(opt);
            }
            else {
                const defaultOpts = ts.getDefaultCompilerOptions();
                defaultOpts.allowNonTsExtensions = true;
                this.setCompilerOptions(defaultOpts);
            }
            this.languageService = ts.createLanguageService(this.host, this.documentRegistry);
            this.classifier = ts.createClassifier();
        }

        setCompilerOptions(opt: ts.CompilerOptions) {
            this.settings = opt;
            this.host.setCompilationSettings(opt);
        }

        isExternalModule(filename: string): boolean {
            const sourceFile = this.languageService.getSourceFile(filename);
            return ts.isExternalModule(sourceFile);
        }

        static defaultFormatCodeOptions: ts.FormatCodeOptions = {
            IndentSize: 4,
            TabSize: 4,
            NewLineCharacter: ts.sys ? ts.sys.newLine : "\n",
            ConvertTabsToSpaces: true,
            IndentStyle: ts.IndentStyle.Smart,
            InsertSpaceAfterCommaDelimiter: true,
            InsertSpaceAfterSemicolonInForStatements: true,
            InsertSpaceBeforeAndAfterBinaryOperators: true,
            InsertSpaceAfterKeywordsInControlFlowStatements: true,
            InsertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
            InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
            InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
            PlaceOpenBraceOnNewLineForFunctions: false,
            PlaceOpenBraceOnNewLineForControlBlocks: false,
        };
    }

    export interface LineCollection {
        charCount(): number;
        lineCount(): number;
        isLeaf(): boolean;
        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker): void;
    }

    export interface ILineInfo {
        line: number;
        offset: number;
        text?: string;
        leaf?: LineLeaf;
    }

    export enum CharRangeSection {
        PreStart,
        Start,
        Entire,
        Mid,
        End,
        PostEnd
    }

    export interface ILineIndexWalker {
        goSubtree: boolean;
        done: boolean;
        leaf(relativeStart: number, relativeLength: number, lineCollection: LineLeaf): void;
        pre?(relativeStart: number, relativeLength: number, lineCollection: LineCollection,
            parent: LineNode, nodeType: CharRangeSection): LineCollection;
        post?(relativeStart: number, relativeLength: number, lineCollection: LineCollection,
            parent: LineNode, nodeType: CharRangeSection): LineCollection;
    }

    class BaseLineIndexWalker implements ILineIndexWalker {
        goSubtree = true;
        done = false;
        leaf(rangeStart: number, rangeLength: number, ll: LineLeaf) {
        }
    }

    class EditWalker extends BaseLineIndexWalker {
        lineIndex = new LineIndex();
        // path to start of range
        startPath: LineCollection[];
        endBranch: LineCollection[] = [];
        branchNode: LineNode;
        // path to current node
        stack: LineNode[];
        state = CharRangeSection.Entire;
        lineCollectionAtBranch: LineCollection;
        initialText = "";
        trailingText = "";
        suppressTrailingText = false;

        constructor() {
            super();
            this.lineIndex.root = new LineNode();
            this.startPath = [this.lineIndex.root];
            this.stack = [this.lineIndex.root];
        }

        insertLines(insertedText: string) {
            if (this.suppressTrailingText) {
                this.trailingText = "";
            }
            if (insertedText) {
                insertedText = this.initialText + insertedText + this.trailingText;
            }
            else {
                insertedText = this.initialText + this.trailingText;
            }
            const lm = LineIndex.linesFromText(insertedText);
            const lines = lm.lines;
            if (lines.length > 1) {
                if (lines[lines.length - 1] == "") {
                    lines.length--;
                }
            }
            let branchParent: LineNode;
            let lastZeroCount: LineCollection;

            for (let k = this.endBranch.length - 1; k >= 0; k--) {
                (<LineNode>this.endBranch[k]).updateCounts();
                if (this.endBranch[k].charCount() === 0) {
                    lastZeroCount = this.endBranch[k];
                    if (k > 0) {
                        branchParent = <LineNode>this.endBranch[k - 1];
                    }
                    else {
                        branchParent = this.branchNode;
                    }
                }
            }
            if (lastZeroCount) {
                branchParent.remove(lastZeroCount);
            }

            // path at least length two (root and leaf)
            let insertionNode = <LineNode>this.startPath[this.startPath.length - 2];
            const leafNode = <LineLeaf>this.startPath[this.startPath.length - 1];
            const len = lines.length;

            if (len > 0) {
                leafNode.text = lines[0];

                if (len > 1) {
                    let insertedNodes = <LineCollection[]>new Array(len - 1);
                    let startNode = <LineCollection>leafNode;
                    for (let i = 1, len = lines.length; i < len; i++) {
                        insertedNodes[i - 1] = new LineLeaf(lines[i]);
                    }
                    let pathIndex = this.startPath.length - 2;
                    while (pathIndex >= 0) {
                        insertionNode = <LineNode>this.startPath[pathIndex];
                        insertedNodes = insertionNode.insertAt(startNode, insertedNodes);
                        pathIndex--;
                        startNode = insertionNode;
                    }
                    let insertedNodesLen = insertedNodes.length;
                    while (insertedNodesLen > 0) {
                        const newRoot = new LineNode();
                        newRoot.add(this.lineIndex.root);
                        insertedNodes = newRoot.insertAt(this.lineIndex.root, insertedNodes);
                        insertedNodesLen = insertedNodes.length;
                        this.lineIndex.root = newRoot;
                    }
                    this.lineIndex.root.updateCounts();
                }
                else {
                    for (let j = this.startPath.length - 2; j >= 0; j--) {
                        (<LineNode>this.startPath[j]).updateCounts();
                    }
                }
            }
            else {
                // no content for leaf node, so delete it
                insertionNode.remove(leafNode);
                for (let j = this.startPath.length - 2; j >= 0; j--) {
                    (<LineNode>this.startPath[j]).updateCounts();
                }
            }

            return this.lineIndex;
        }

        post(relativeStart: number, relativeLength: number, lineCollection: LineCollection, parent: LineCollection, nodeType: CharRangeSection): LineCollection {
            // have visited the path for start of range, now looking for end
            // if range is on single line, we will never make this state transition
            if (lineCollection === this.lineCollectionAtBranch) {
                this.state = CharRangeSection.End;
            }
            // always pop stack because post only called when child has been visited
            this.stack.length--;
            return undefined;
        }

        pre(relativeStart: number, relativeLength: number, lineCollection: LineCollection, parent: LineCollection, nodeType: CharRangeSection) {
            // currentNode corresponds to parent, but in the new tree
            const currentNode = this.stack[this.stack.length - 1];

            if ((this.state === CharRangeSection.Entire) && (nodeType === CharRangeSection.Start)) {
                // if range is on single line, we will never make this state transition
                this.state = CharRangeSection.Start;
                this.branchNode = currentNode;
                this.lineCollectionAtBranch = lineCollection;
            }

            let child: LineCollection;
            function fresh(node: LineCollection): LineCollection {
                if (node.isLeaf()) {
                    return new LineLeaf("");
                }
                else return new LineNode();
            }
            switch (nodeType) {
                case CharRangeSection.PreStart:
                    this.goSubtree = false;
                    if (this.state !== CharRangeSection.End) {
                        currentNode.add(lineCollection);
                    }
                    break;
                case CharRangeSection.Start:
                    if (this.state === CharRangeSection.End) {
                        this.goSubtree = false;
                    }
                    else {
                        child = fresh(lineCollection);
                        currentNode.add(child);
                        this.startPath[this.startPath.length] = child;
                    }
                    break;
                case CharRangeSection.Entire:
                    if (this.state !== CharRangeSection.End) {
                        child = fresh(lineCollection);
                        currentNode.add(child);
                        this.startPath[this.startPath.length] = child;
                    }
                    else {
                        if (!lineCollection.isLeaf()) {
                            child = fresh(lineCollection);
                            currentNode.add(child);
                            this.endBranch[this.endBranch.length] = child;
                        }
                    }
                    break;
                case CharRangeSection.Mid:
                    this.goSubtree = false;
                    break;
                case CharRangeSection.End:
                    if (this.state !== CharRangeSection.End) {
                        this.goSubtree = false;
                    }
                    else {
                        if (!lineCollection.isLeaf()) {
                            child = fresh(lineCollection);
                            currentNode.add(child);
                            this.endBranch[this.endBranch.length] = child;
                        }
                    }
                    break;
                case CharRangeSection.PostEnd:
                    this.goSubtree = false;
                    if (this.state !== CharRangeSection.Start) {
                        currentNode.add(lineCollection);
                    }
                    break;
            }
            if (this.goSubtree) {
                this.stack[this.stack.length] = <LineNode>child;
            }
            return lineCollection;
        }
        // just gather text from the leaves
        leaf(relativeStart: number, relativeLength: number, ll: LineLeaf) {
            if (this.state === CharRangeSection.Start) {
                this.initialText = ll.text.substring(0, relativeStart);
            }
            else if (this.state === CharRangeSection.Entire) {
                this.initialText = ll.text.substring(0, relativeStart);
                this.trailingText = ll.text.substring(relativeStart + relativeLength);
            }
            else {
                // state is CharRangeSection.End
                this.trailingText = ll.text.substring(relativeStart + relativeLength);
            }
        }
    }

    // text change information
    export class TextChange {
        constructor(public pos: number, public deleteLen: number, public insertedText?: string) {
        }

        getTextChangeRange() {
            return ts.createTextChangeRange(ts.createTextSpan(this.pos, this.deleteLen),
                this.insertedText ? this.insertedText.length : 0);
        }
    }

    export class ScriptVersionCache {
        changes: TextChange[] = [];
        versions: LineIndexSnapshot[] = [];
        minVersion = 0;  // no versions earlier than min version will maintain change history
        private currentVersion = 0;
        private host: ServerHost;

        static changeNumberThreshold = 8;
        static changeLengthThreshold = 256;
        static maxVersions = 8;

        // REVIEW: can optimize by coalescing simple edits
        edit(pos: number, deleteLen: number, insertedText?: string) {
            this.changes[this.changes.length] = new TextChange(pos, deleteLen, insertedText);
            if ((this.changes.length > ScriptVersionCache.changeNumberThreshold) ||
                (deleteLen > ScriptVersionCache.changeLengthThreshold) ||
                (insertedText && (insertedText.length > ScriptVersionCache.changeLengthThreshold))) {
                this.getSnapshot();
            }
        }

        latest() {
            return this.versions[this.currentVersion];
        }

        latestVersion() {
            if (this.changes.length > 0) {
                this.getSnapshot();
            }
            return this.currentVersion;
        }

        reloadFromFile(filename: string, cb?: () => any) {
            const content = this.host.readFile(filename);
            this.reload(content);
            if (cb)
                cb();
        }

        // reload whole script, leaving no change history behind reload
        reload(script: string) {
            this.currentVersion++;
            this.changes = []; // history wiped out by reload
            const snap = new LineIndexSnapshot(this.currentVersion, this);
            this.versions[this.currentVersion] = snap;
            snap.index = new LineIndex();
            const lm = LineIndex.linesFromText(script);
            snap.index.load(lm.lines);
            // REVIEW: could use linked list
            for (let i = this.minVersion; i < this.currentVersion; i++) {
                this.versions[i] = undefined;
            }
            this.minVersion = this.currentVersion;

        }

        getSnapshot() {
            let snap = this.versions[this.currentVersion];
            if (this.changes.length > 0) {
                let snapIndex = this.latest().index;
                for (let i = 0, len = this.changes.length; i < len; i++) {
                    const change = this.changes[i];
                    snapIndex = snapIndex.edit(change.pos, change.deleteLen, change.insertedText);
                }
                snap = new LineIndexSnapshot(this.currentVersion + 1, this);
                snap.index = snapIndex;
                snap.changesSincePreviousVersion = this.changes;
                this.currentVersion = snap.version;
                this.versions[snap.version] = snap;
                this.changes = [];
                if ((this.currentVersion - this.minVersion) >= ScriptVersionCache.maxVersions) {
                    const oldMin = this.minVersion;
                    this.minVersion = (this.currentVersion - ScriptVersionCache.maxVersions) + 1;
                    for (let j = oldMin; j < this.minVersion; j++) {
                        this.versions[j] = undefined;
                    }
                }
            }
            return snap;
        }

        getTextChangesBetweenVersions(oldVersion: number, newVersion: number) {
            if (oldVersion < newVersion) {
                if (oldVersion >= this.minVersion) {
                    const textChangeRanges: ts.TextChangeRange[] = [];
                    for (let i = oldVersion + 1; i <= newVersion; i++) {
                        const snap = this.versions[i];
                        for (let j = 0, len = snap.changesSincePreviousVersion.length; j < len; j++) {
                            const textChange = snap.changesSincePreviousVersion[j];
                            textChangeRanges[textChangeRanges.length] = textChange.getTextChangeRange();
                        }
                    }
                    return ts.collapseTextChangeRangesAcrossMultipleVersions(textChangeRanges);
                }
                else {
                    return undefined;
                }
            }
            else {
                return ts.unchangedTextChangeRange;
            }
        }

        static fromString(host: ServerHost, script: string) {
            const svc = new ScriptVersionCache();
            const snap = new LineIndexSnapshot(0, svc);
            svc.versions[svc.currentVersion] = snap;
            svc.host = host;
            snap.index = new LineIndex();
            const lm = LineIndex.linesFromText(script);
            snap.index.load(lm.lines);
            return svc;
        }
    }

    export class LineIndexSnapshot implements ts.IScriptSnapshot {
        index: LineIndex;
        changesSincePreviousVersion: TextChange[] = [];

        constructor(public version: number, public cache: ScriptVersionCache) {
        }

        getText(rangeStart: number, rangeEnd: number) {
            return this.index.getText(rangeStart, rangeEnd - rangeStart);
        }

        getLength() {
            return this.index.root.charCount();
        }

        // this requires linear space so don't hold on to these
        getLineStartPositions(): number[] {
            const starts: number[] = [-1];
            let count = 1;
            let pos = 0;
            this.index.every((ll, s, len) => {
                starts[count] = pos;
                count++;
                pos += ll.text.length;
                return true;
            }, 0);
            return starts;
        }

        getLineMapper() {
            return (line: number) => {
                return this.index.lineNumberToInfo(line).offset;
            };
        }

        getTextChangeRangeSinceVersion(scriptVersion: number) {
            if (this.version <= scriptVersion) {
                return ts.unchangedTextChangeRange;
            }
            else {
                return this.cache.getTextChangesBetweenVersions(scriptVersion, this.version);
            }
        }
        getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
            const oldSnap = <LineIndexSnapshot>oldSnapshot;
            return this.getTextChangeRangeSinceVersion(oldSnap.version);
        }
    }

    export class LineIndex {
        root: LineNode;
        // set this to true to check each edit for accuracy
        checkEdits = false;

        charOffsetToLineNumberAndPos(charOffset: number) {
            return this.root.charOffsetToLineNumberAndPos(1, charOffset);
        }

        lineNumberToInfo(lineNumber: number): ILineInfo {
            const lineCount = this.root.lineCount();
            if (lineNumber <= lineCount) {
                const lineInfo = this.root.lineNumberToInfo(lineNumber, 0);
                lineInfo.line = lineNumber;
                return lineInfo;
            }
            else {
                return {
                    line: lineNumber,
                    offset: this.root.charCount()
                };
            }
        }

        load(lines: string[]) {
            if (lines.length > 0) {
                const leaves: LineLeaf[] = [];
                for (let i = 0, len = lines.length; i < len; i++) {
                    leaves[i] = new LineLeaf(lines[i]);
                }
                this.root = LineIndex.buildTreeFromBottom(leaves);
            }
            else {
                this.root = new LineNode();
            }
        }

        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
            this.root.walk(rangeStart, rangeLength, walkFns);
        }

        getText(rangeStart: number, rangeLength: number) {
            let accum = "";
            if ((rangeLength > 0) && (rangeStart < this.root.charCount())) {
                this.walk(rangeStart, rangeLength, {
                    goSubtree: true,
                    done: false,
                    leaf: (relativeStart: number, relativeLength: number, ll: LineLeaf) => {
                        accum = accum.concat(ll.text.substring(relativeStart, relativeStart + relativeLength));
                    }
                });
            }
            return accum;
        }

        getLength(): number {
            return this.root.charCount();
        }

        every(f: (ll: LineLeaf, s: number, len: number) => boolean, rangeStart: number, rangeEnd?: number) {
            if (!rangeEnd) {
                rangeEnd = this.root.charCount();
            }
            const walkFns = {
                goSubtree: true,
                done: false,
                leaf: function (relativeStart: number, relativeLength: number, ll: LineLeaf) {
                    if (!f(ll, relativeStart, relativeLength)) {
                        this.done = true;
                    }
                }
            };
            this.walk(rangeStart, rangeEnd - rangeStart, walkFns);
            return !walkFns.done;
        }

        edit(pos: number, deleteLength: number, newText?: string) {
            function editFlat(source: string, s: number, dl: number, nt = "") {
                return source.substring(0, s) + nt + source.substring(s + dl, source.length);
            }
            if (this.root.charCount() === 0) {
                // TODO: assert deleteLength === 0
                if (newText) {
                    this.load(LineIndex.linesFromText(newText).lines);
                    return this;
                }
            }
            else {
                let checkText: string;
                if (this.checkEdits) {
                    checkText = editFlat(this.getText(0, this.root.charCount()), pos, deleteLength, newText);
                }
                const walker = new EditWalker();
                if (pos >= this.root.charCount()) {
                    // insert at end
                    pos = this.root.charCount() - 1;
                    const endString = this.getText(pos, 1);
                    if (newText) {
                        newText = endString + newText;
                    }
                    else {
                        newText = endString;
                    }
                    deleteLength = 0;
                    walker.suppressTrailingText = true;
                }
                else if (deleteLength > 0) {
                    // check whether last characters deleted are line break
                    const e = pos + deleteLength;
                    const lineInfo = this.charOffsetToLineNumberAndPos(e);
                    if ((lineInfo && (lineInfo.offset === 0))) {
                        // move range end just past line that will merge with previous line
                        deleteLength += lineInfo.text.length;
                        // store text by appending to end of insertedText
                        if (newText) {
                            newText = newText + lineInfo.text;
                        }
                        else {
                            newText = lineInfo.text;
                        }
                    }
                }
                if (pos < this.root.charCount()) {
                    this.root.walk(pos, deleteLength, walker);
                    walker.insertLines(newText);
                }
                if (this.checkEdits) {
                    const updatedText = this.getText(0, this.root.charCount());
                    Debug.assert(checkText == updatedText, "buffer edit mismatch");
                }
                return walker.lineIndex;
            }
        }

        static buildTreeFromBottom(nodes: LineCollection[]): LineNode {
            const nodeCount = Math.ceil(nodes.length / lineCollectionCapacity);
            const interiorNodes: LineNode[] = [];
            let nodeIndex = 0;
            for (let i = 0; i < nodeCount; i++) {
                interiorNodes[i] = new LineNode();
                let charCount = 0;
                let lineCount = 0;
                for (let j = 0; j < lineCollectionCapacity; j++) {
                    if (nodeIndex < nodes.length) {
                        interiorNodes[i].add(nodes[nodeIndex]);
                        charCount += nodes[nodeIndex].charCount();
                        lineCount += nodes[nodeIndex].lineCount();
                    }
                    else {
                        break;
                    }
                    nodeIndex++;
                }
                interiorNodes[i].totalChars = charCount;
                interiorNodes[i].totalLines = lineCount;
            }
            if (interiorNodes.length === 1) {
                return interiorNodes[0];
            }
            else {
                return this.buildTreeFromBottom(interiorNodes);
            }
        }

        static linesFromText(text: string) {
            const lineStarts = ts.computeLineStarts(text);

            if (lineStarts.length === 0) {
                return { lines: <string[]>[], lineMap: lineStarts };
            }
            const lines = <string[]>new Array(lineStarts.length);
            const lc = lineStarts.length - 1;
            for (let lmi = 0; lmi < lc; lmi++) {
                lines[lmi] = text.substring(lineStarts[lmi], lineStarts[lmi + 1]);
            }

            const endText = text.substring(lineStarts[lc]);
            if (endText.length > 0) {
                lines[lc] = endText;
            }
            else {
                lines.length--;
            }
            return { lines: lines, lineMap: lineStarts };
        }
    }

    export class LineNode implements LineCollection {
        totalChars = 0;
        totalLines = 0;
        children: LineCollection[] = [];

        isLeaf() {
            return false;
        }

        updateCounts() {
            this.totalChars = 0;
            this.totalLines = 0;
            for (let i = 0, len = this.children.length; i < len; i++) {
                const child = this.children[i];
                this.totalChars += child.charCount();
                this.totalLines += child.lineCount();
            }
        }

        execWalk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker, childIndex: number, nodeType: CharRangeSection) {
            if (walkFns.pre) {
                walkFns.pre(rangeStart, rangeLength, this.children[childIndex], this, nodeType);
            }
            if (walkFns.goSubtree) {
                this.children[childIndex].walk(rangeStart, rangeLength, walkFns);
                if (walkFns.post) {
                    walkFns.post(rangeStart, rangeLength, this.children[childIndex], this, nodeType);
                }
            }
            else {
                walkFns.goSubtree = true;
            }
            return walkFns.done;
        }

        skipChild(relativeStart: number, relativeLength: number, childIndex: number, walkFns: ILineIndexWalker, nodeType: CharRangeSection) {
            if (walkFns.pre && (!walkFns.done)) {
                walkFns.pre(relativeStart, relativeLength, this.children[childIndex], this, nodeType);
                walkFns.goSubtree = true;
            }
        }

        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
            // assume (rangeStart < this.totalChars) && (rangeLength <= this.totalChars)
            let childIndex = 0;
            let child = this.children[0];
            let childCharCount = child.charCount();
            // find sub-tree containing start
            let adjustedStart = rangeStart;
            while (adjustedStart >= childCharCount) {
                this.skipChild(adjustedStart, rangeLength, childIndex, walkFns, CharRangeSection.PreStart);
                adjustedStart -= childCharCount;
                childIndex++;
                child = this.children[childIndex];
                childCharCount = child.charCount();
            }
            // Case I: both start and end of range in same subtree
            if ((adjustedStart + rangeLength) <= childCharCount) {
                if (this.execWalk(adjustedStart, rangeLength, walkFns, childIndex, CharRangeSection.Entire)) {
                    return;
                }
            }
            else {
                // Case II: start and end of range in different subtrees (possibly with subtrees in the middle)
                if (this.execWalk(adjustedStart, childCharCount - adjustedStart, walkFns, childIndex, CharRangeSection.Start)) {
                    return;
                }
                let adjustedLength = rangeLength - (childCharCount - adjustedStart);
                childIndex++;
                child = this.children[childIndex];
                childCharCount = child.charCount();
                while (adjustedLength > childCharCount) {
                    if (this.execWalk(0, childCharCount, walkFns, childIndex, CharRangeSection.Mid)) {
                        return;
                    }
                    adjustedLength -= childCharCount;
                    childIndex++;
                    child = this.children[childIndex];
                    childCharCount = child.charCount();
                }
                if (adjustedLength > 0) {
                    if (this.execWalk(0, adjustedLength, walkFns, childIndex, CharRangeSection.End)) {
                        return;
                    }
                }
            }
            // Process any subtrees after the one containing range end
            if (walkFns.pre) {
                const clen = this.children.length;
                if (childIndex < (clen - 1)) {
                    for (let ej = childIndex + 1; ej < clen; ej++) {
                        this.skipChild(0, 0, ej, walkFns, CharRangeSection.PostEnd);
                    }
                }
            }
        }

        charOffsetToLineNumberAndPos(lineNumber: number, charOffset: number): ILineInfo {
            const childInfo = this.childFromCharOffset(lineNumber, charOffset);
            if (!childInfo.child) {
                return {
                    line: lineNumber,
                    offset: charOffset,
                };
            }
            else if (childInfo.childIndex < this.children.length) {
                if (childInfo.child.isLeaf()) {
                    return {
                        line: childInfo.lineNumber,
                        offset: childInfo.charOffset,
                        text: (<LineLeaf>(childInfo.child)).text,
                        leaf: (<LineLeaf>(childInfo.child))
                    };
                }
                else {
                    const lineNode = <LineNode>(childInfo.child);
                    return lineNode.charOffsetToLineNumberAndPos(childInfo.lineNumber, childInfo.charOffset);
                }
            }
            else {
                const lineInfo = this.lineNumberToInfo(this.lineCount(), 0);
                return { line: this.lineCount(), offset: lineInfo.leaf.charCount() };
            }
        }

        lineNumberToInfo(lineNumber: number, charOffset: number): ILineInfo {
            const childInfo = this.childFromLineNumber(lineNumber, charOffset);
            if (!childInfo.child) {
                return {
                    line: lineNumber,
                    offset: charOffset
                };
            }
            else if (childInfo.child.isLeaf()) {
                return {
                    line: lineNumber,
                    offset: childInfo.charOffset,
                    text: (<LineLeaf>(childInfo.child)).text,
                    leaf: (<LineLeaf>(childInfo.child))
                };
            }
            else {
                const lineNode = <LineNode>(childInfo.child);
                return lineNode.lineNumberToInfo(childInfo.relativeLineNumber, childInfo.charOffset);
            }
        }

        childFromLineNumber(lineNumber: number, charOffset: number) {
            let child: LineCollection;
            let relativeLineNumber = lineNumber;
            let i: number;
            let len: number;
            for (i = 0, len = this.children.length; i < len; i++) {
                child = this.children[i];
                const childLineCount = child.lineCount();
                if (childLineCount >= relativeLineNumber) {
                    break;
                }
                else {
                    relativeLineNumber -= childLineCount;
                    charOffset += child.charCount();
                }
            }
            return {
                child: child,
                childIndex: i,
                relativeLineNumber: relativeLineNumber,
                charOffset: charOffset
            };
        }

        childFromCharOffset(lineNumber: number, charOffset: number) {
            let child: LineCollection;
            let i: number;
            let len: number;
            for (i = 0, len = this.children.length; i < len; i++) {
                child = this.children[i];
                if (child.charCount() > charOffset) {
                    break;
                }
                else {
                    charOffset -= child.charCount();
                    lineNumber += child.lineCount();
                }
            }
            return {
                child: child,
                childIndex: i,
                charOffset: charOffset,
                lineNumber: lineNumber
            };
        }

        splitAfter(childIndex: number) {
            let splitNode: LineNode;
            const clen = this.children.length;
            childIndex++;
            const endLength = childIndex;
            if (childIndex < clen) {
                splitNode = new LineNode();
                while (childIndex < clen) {
                    splitNode.add(this.children[childIndex]);
                    childIndex++;
                }
                splitNode.updateCounts();
            }
            this.children.length = endLength;
            return splitNode;
        }

        remove(child: LineCollection) {
            const childIndex = this.findChildIndex(child);
            const clen = this.children.length;
            if (childIndex < (clen - 1)) {
                for (let i = childIndex; i < (clen - 1); i++) {
                    this.children[i] = this.children[i + 1];
                }
            }
            this.children.length--;
        }

        findChildIndex(child: LineCollection) {
            let childIndex = 0;
            const clen = this.children.length;
            while ((this.children[childIndex] !== child) && (childIndex < clen)) childIndex++;
            return childIndex;
        }

        insertAt(child: LineCollection, nodes: LineCollection[]) {
            let childIndex = this.findChildIndex(child);
            const clen = this.children.length;
            const nodeCount = nodes.length;
            // if child is last and there is more room and only one node to place, place it
            if ((clen < lineCollectionCapacity) && (childIndex === (clen - 1)) && (nodeCount === 1)) {
                this.add(nodes[0]);
                this.updateCounts();
                return [];
            }
            else {
                const shiftNode = this.splitAfter(childIndex);
                let nodeIndex = 0;
                childIndex++;
                while ((childIndex < lineCollectionCapacity) && (nodeIndex < nodeCount)) {
                    this.children[childIndex] = nodes[nodeIndex];
                    childIndex++;
                    nodeIndex++;
                }
                let splitNodes: LineNode[] = [];
                let splitNodeCount = 0;
                if (nodeIndex < nodeCount) {
                    splitNodeCount = Math.ceil((nodeCount - nodeIndex) / lineCollectionCapacity);
                    splitNodes = <LineNode[]>new Array(splitNodeCount);
                    let splitNodeIndex = 0;
                    for (let i = 0; i < splitNodeCount; i++) {
                        splitNodes[i] = new LineNode();
                    }
                    let splitNode = <LineNode>splitNodes[0];
                    while (nodeIndex < nodeCount) {
                        splitNode.add(nodes[nodeIndex]);
                        nodeIndex++;
                        if (splitNode.children.length === lineCollectionCapacity) {
                            splitNodeIndex++;
                            splitNode = <LineNode>splitNodes[splitNodeIndex];
                        }
                    }
                    for (let i = splitNodes.length - 1; i >= 0; i--) {
                        if (splitNodes[i].children.length === 0) {
                            splitNodes.length--;
                        }
                    }
                }
                if (shiftNode) {
                    splitNodes[splitNodes.length] = shiftNode;
                }
                this.updateCounts();
                for (let i = 0; i < splitNodeCount; i++) {
                    (<LineNode>splitNodes[i]).updateCounts();
                }
                return splitNodes;
            }
        }

        // assume there is room for the item; return true if more room
        add(collection: LineCollection) {
            this.children[this.children.length] = collection;
            return (this.children.length < lineCollectionCapacity);
        }

        charCount() {
            return this.totalChars;
        }

        lineCount() {
            return this.totalLines;
        }
    }

    export class LineLeaf implements LineCollection {
        udata: any;

        constructor(public text: string) {

        }

        setUdata(data: any) {
            this.udata = data;
        }

        getUdata() {
            return this.udata;
        }

        isLeaf() {
            return true;
        }

        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
            walkFns.leaf(rangeStart, rangeLength, this);
        }

        charCount() {
            return this.text.length;
        }

        lineCount() {
            return 1;
        }
    }
}
