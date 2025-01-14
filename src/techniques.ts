import * as vscode from 'vscode';
import { completionFormat, configSection, debug } from './configuration';
import { minTermLength, log, techniqueRegex } from './helpers';

let techniqueCompletionItems: Array<vscode.CompletionItem> = new Array<vscode.CompletionItem>();

/*
    Build a completion item's insertion text based on settings
*/
function buildInsertionText(technique: Technique): string {
    let insertionText: string = technique.id;
    if (completionFormat === 'id-name') {
        insertionText = `${technique.id} ${technique.name}`;
    }
    else if (completionFormat === 'name') {
        insertionText = technique.name;
    }
    else if (completionFormat === 'link') {
        insertionText = technique.url;
    }
    else if (completionFormat === 'fullname') {
        // only apply this format when the technique has a parent
        if (technique.parent !== undefined) {
            insertionText = `${technique.parent.name}: ${technique.name}`;
        }
        else {
            // otherwise, assume the user wants the name configuration
            insertionText = technique.name;
        }
    }
    else if (completionFormat === 'id-fullname') {
        // only apply this format when the technique has a parent
        if (technique.parent !== undefined) {
            insertionText = `${technique.id} ${technique.parent.name}: ${technique.name}`;
        }
        else {
            // otherwise, assume the user wants the id-name configuration
            insertionText = `${technique.id} ${technique.name}`;
        }
    }
    return insertionText;
}

/*
    Build a completion item out of a technique
*/
function buildCompletionItem(label: string, technique: Technique): vscode.CompletionItem {
    const completionItem: vscode.CompletionItem = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value);
    const insertionText: string = buildInsertionText(technique);
    if (technique.deprecated || technique.revoked) { completionItem.tags = [vscode.CompletionItemTag.Deprecated]; }
    completionItem.detail = insertionText;
    completionItem.insertText = insertionText;
    return completionItem;
}

/*
    Build a technique's description based on settings
*/
function buildTechniqueDescription(technique: Technique, descriptionType: string|undefined = undefined): vscode.MarkdownString {
    // currently, completion items that result from searching the technique description manually set the descriptionType to 'long'
    // ... but every other type of completion item should derive this value from the extension configuration
    if (descriptionType === undefined) { descriptionType = vscode.workspace.getConfiguration(configSection).get('description'); }
    const mdBuilder: vscode.MarkdownString = new vscode.MarkdownString(undefined);
    // title
    let title = '';
    if (technique.parent !== undefined) { title = `${technique.parent.name}: ${technique.name}`; }
    else { title = `${technique.name}`; }
    if (technique.revoked) { title += ' (REVOKED)'; }
    mdBuilder.appendMarkdown(`### ${title}\n`);
    // source link
    if (technique.url !== undefined) { mdBuilder.appendMarkdown(`[Source Link](${technique.url})\n\n`); }
    else { mdBuilder.appendMarkdown(`No source link available\n\n`); }
    // tactics
    if (technique.tactics?.length === 1) { mdBuilder.appendMarkdown(`**Tactic**: ${technique.tactics.pop()}\n\n`); }
    else if (technique.tactics?.length > 1) { mdBuilder.appendMarkdown(`**Tactics**: ${technique.tactics.join(', ')}\n\n`); }
    // description
    if (descriptionType && descriptionType === 'long') { mdBuilder.appendMarkdown(technique.description.long); }
    else if (descriptionType && descriptionType === 'short') { mdBuilder.appendMarkdown(technique.description.short); }
    return mdBuilder;
}

/*
    Check settings and determine how the completion items should insert text
*/
function generateCompletionItems(currentTechniques: Array<Technique>): void {
    const techniques: Array<Technique> = currentTechniques;
    techniqueCompletionItems = new Array<vscode.CompletionItem>();
    techniqueCompletionItems = techniques.map<vscode.CompletionItem>((t: Technique) => {
        const insertionText: string = buildInsertionText(t);
        // first create completion item for name => TID
        let completionItem: vscode.CompletionItem = new vscode.CompletionItem(t.name, vscode.CompletionItemKind.Value);
        completionItem.detail = insertionText;
        completionItem.insertText = insertionText;
        // if technique has a parent then use that for the filter text, otherwise just use the name + TID
        const filterText: string = t.parent !== undefined ? `${t.parent?.name}: ${t.name}` : `${t.name}`;
        completionItem.filterText = filterText;
        if (t.deprecated || t.revoked) { completionItem.tags = [vscode.CompletionItemTag.Deprecated]; }
        techniqueCompletionItems.push(completionItem);
        // then create completion item for TID => TID
        completionItem = new vscode.CompletionItem(t.id, vscode.CompletionItemKind.Value);
        completionItem.detail = insertionText;
        completionItem.insertText = insertionText;
        if (t.deprecated || t.revoked) { completionItem.tags = [vscode.CompletionItemTag.Deprecated]; }
        return completionItem;
    });
}

/*
    Parse and generate relevant objects for use in other features, such as code completion and hover
*/
export async function init(attackData: AttackMap): Promise<Technique[]> {
    return new Promise((resolve) => {
        let techniques: Array<Technique> = new Array<Technique>();
        techniques = attackData.objects.filter((item: AttackObject) => {
            // ignore non-techniques
            return item.type === 'attack-pattern';
        }).map<Technique>((item: AttackObject) => {
            const description: string = item.description !== undefined ? item.description : 'No description available.';
            const technique: Technique = {
                description: {
                    short: description.split("\n")[0],
                    long: description
                },
                id: '<unknown>',
                name: item.name,
                parent: undefined,
                revoked: item.revoked,
                deprecated: item.x_mitre_deprecated,
                subtechnique: item.x_mitre_is_subtechnique,
                tactics: [],
                url: '<unknown>'
            };
            item.external_references?.forEach((reference: ExternalReference) => {
                if (reference.source_name === 'mitre-attack') {
                    technique.id = reference.external_id;
                    technique.url = reference.url;
                    return; // found what we were looking for - no need to iterate over the rest
                }
            });
            technique.tactics = item.kill_chain_phases?.filter((phase: KillChainPhase) => {
                return phase.kill_chain_name === 'mitre-attack';
            }).map<string>((phase: KillChainPhase) => { return phase.phase_name; });
            return technique;
        });
        // now that all the techniques are parsed we can generate the parent relationships for subtechniques
        techniques.forEach((technique: Technique) => {
            if (technique.subtechnique) {
                const parentTID: string | undefined = technique.id.split('.').shift()?.toString();
                if (parentTID !== undefined) {
                    const parent: Technique | undefined = techniques.find((t: Technique) => { return t.id === parentTID; });
                    if (parent !== undefined) {
                        technique.parent = parent;
                    }
                }
            }
        });
        if (debug) { log(`Parsed out ${techniques.length} techniques`); }
        resolve(techniques);
    });
}

export class TechniqueHoverProvider implements vscode.HoverProvider {
    public techniques: Array<Technique> = new Array<Technique>();

    public provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        try {
            return new Promise((resolve) => {
                token.onCancellationRequested(() => {
                    // if this process is cancelled, just return nothing
                    if (debug) { log('TechniqueHoverProvider: Task cancelled!'); }
                    resolve(undefined);
                });
                let hover: vscode.Hover | undefined = undefined;
                // gotta match the following: T1000, T1000.001, T1000/001
                let hoverRange: vscode.Range | undefined = undefined;
                hoverRange = document.getWordRangeAtPosition(position, techniqueRegex);
                if (hoverRange !== undefined) {
                    const hoverTerm: string = document.getText(hoverRange);
                    const currentTechnique: Technique | undefined = this.techniques.find((t: Technique) => { return t.id === hoverTerm; });
                    if (currentTechnique !== undefined) {
                        if (debug) { log(`TechniqueHoverProvider: Found exact Technique ID '${currentTechnique.id}'`); }
                        hover = new vscode.Hover(buildTechniqueDescription(currentTechnique), hoverRange);
                    }
                }
                resolve(hover);
            });
        } catch (error) {
            log(`TechniqueHoverProvider error: ${error}`);
        }
    }
}

export class TechniqueCompletionProvider implements vscode.CompletionItemProvider {
    private maxDescriptionItems = 3;
    public techniques: Array<Technique> = new Array<Technique>();
    public revokedTechniques: Array<Technique> = new Array<Technique>();

    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        try {
            return new Promise((resolve) => {
                token.onCancellationRequested(() => {
                    // if this process is cancelled, just return nothing
                    if (debug) { log('TechniqueCompletionProvider: Task cancelled!'); }
                    resolve(undefined);
                });
                let completionItems: Array<vscode.CompletionItem> = new Array<vscode.CompletionItem>();
                // without the regex, if a user tries to complete a subtechnique
                // ... only the numbers after the dot would be completed
                const completionRange: vscode.Range | undefined = document.getWordRangeAtPosition(position, /\S+/);
                if (completionRange === undefined) {
                    if (debug) { log('TechniqueCompletionProvider: No completion item range provided. Returning everything'); }
                    completionItems = techniqueCompletionItems;
                }
                else {
                    const completionTerm: string = document.getText(completionRange);
                    // if this is a short completion term, return every parsed technique without further action
                    if (completionTerm.length < minTermLength) {
                        if (debug) { log('TechniqueCompletionProvider: Short completion term detected. Returning everything'); }
                        completionItems = techniqueCompletionItems;
                    }
                    // do not search technique descriptions if the TID matches a revoked technique
                    else if (this.revokedTechniques.find((t: Technique) => { return t.id === completionTerm.toUpperCase(); })) {
                        if (debug) { log(`TechniqueCompletionProvider: Completion term '${completionTerm}' found in revoked techniques`); }
                        completionItems = new Array<vscode.CompletionItem>();
                    }
                    // if the user is trying to complete something that matches an exact technique ID, just return that one item
                    else {
                        const technique: Technique | undefined = this.techniques.find((t: Technique) => { return t.id === completionTerm.toUpperCase(); });
                        if (technique !== undefined) {
                            if (debug) { log(`TechniqueCompletionProvider: Found exact Technique ID '${technique.id}'`); }
                            completionItems = [buildCompletionItem(technique.id, technique)];
                        }
                        else {
                            // if the user is trying to complete a technique by name
                            // ... then return every known technique (for expediency's sake) and let the VSCode engine do the filtering
                            const possibleTechniques: Technique[] | undefined = this.techniques.filter((t: Technique) => {
                                // same filter text used in completion items
                                const filterText: string = t.parent !== undefined ? `${t.parent?.name}: ${t.name}` : `${t.name}`;
                                return filterText.toLowerCase().includes(completionTerm.toLowerCase());
                            });
                            if (possibleTechniques !== undefined) {
                                completionItems = possibleTechniques.map<vscode.CompletionItem>((t: Technique) => {
                                    if (debug) { log(`TechniqueCompletionProvider: Found possible Technique '${t.name}'`); }
                                    return buildCompletionItem(t.name, t);
                                });
                            }
                        }
                        // if at this point we still don't know what the user is trying to complete, and the user manually invoked the completion
                        // ... search all the technique descriptions for matching keywords
                        if (completionItems.length === 0 && context.triggerKind === vscode.CompletionTriggerKind.Invoke) {
                            if (debug) { log(`TechniqueCompletionProvider: Term '${completionTerm}' meets length threshold for description searching`); }
                            completionItems = this.techniques.filter((t: Technique) => {
                                return t.description.long.toLowerCase().includes(completionTerm.toLowerCase());
                            }).map<vscode.CompletionItem>((t: Technique) => {
                                if (debug) { log(`TechniqueCompletionProvider: Found matching technique description in '${t.id}: ${t.name}'`); }
                                const item: vscode.CompletionItem = buildCompletionItem(`${completionTerm} (technique description)`, t);
                                // always show the long description because that's what we're searching in
                                const documentation: vscode.MarkdownString = buildTechniqueDescription(t, 'long');
                                // ... highlight our searchterm
                                documentation.value = documentation.value.replace(completionTerm, `**${completionTerm}**`);
                                // ... then replace the completion item with the new one for this special case
                                item.documentation = documentation;
                                // ... and finally let the user know if the item was deprecated
                                if (t.deprecated || t.revoked) { item.tags = [vscode.CompletionItemTag.Deprecated]; }
                                return item;
                            });
                            // if we have found too many matching techniques, then this term is too common, and
                            // ... we should assume all completionItems we generated are unrelated to the requested term
                            if (completionItems.length > this.maxDescriptionItems) {
                                resolve(undefined);
                            }
                        }
                    }
                }
                resolve(completionItems);
            });
        } catch (error) {
            log(`TechniqueCompletionProvider error: ${error}`);
        }
    }

    public resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
        try {
            return new Promise((resolve) => {
                token.onCancellationRequested(() => {
                    // if this process is cancelled, just return nothing
                    if (debug) { log('TechniqueCompletionProvider: Resolution task cancelled!'); }
                    resolve(undefined);
                });
                if (debug) { log(`TechniqueCompletionProvider: Resolving completion item for '${item.label}'`); }
                item.keepWhitespace = true;
                // some items will already have documentation filled out at creation time
                // ... such as technique description items, because we cannot correlate them back to a technique at resolution
                if (item.documentation === undefined) {
                    const technique: Technique | undefined = this.techniques.filter((t: Technique) => {
                        if (item.tags?.includes(vscode.CompletionItemTag.Deprecated)) {
                            return t.revoked || t.deprecated;
                        }
                        else {
                            // or if the completion item is not deprecated, only non-revoked techniques are possible
                            return !t.revoked && !t.deprecated;
                        }
                    }).find((t: Technique) => {
                        return (t.id === item.label) || (t.name === item.label);
                    });
                    if (technique !== undefined) {
                        item.documentation = buildTechniqueDescription(technique);
                    }
                }
                resolve(item);
            });
        }
        catch (error) {
            log(`TechniqueCompletionProvider error: ${error}`);
        }
    }
}

export function register(filters: vscode.DocumentSelector, techniques: Array<Technique>): Array<vscode.Disposable> {
    log('Registering providers for Techniques');
    // hover provider
    const techniqueHovers: TechniqueHoverProvider = new TechniqueHoverProvider();
    techniqueHovers.techniques = techniques;
    const techniqueHoverDisposable: vscode.Disposable = vscode.languages.registerHoverProvider(filters, techniqueHovers);
    // completion provider
    const techniqueCompletions: TechniqueCompletionProvider = new TechniqueCompletionProvider();
    techniqueCompletions.techniques = techniques.filter((technique: Technique) => { return technique.revoked !== true; });
    techniqueCompletions.revokedTechniques = techniques.filter((technique: Technique) => { return technique.revoked === true; });
    const techniqueCompletionDisposable: vscode.Disposable = vscode.languages.registerCompletionItemProvider(filters, techniqueCompletions);
    // only complete non-revoked items
    generateCompletionItems(techniques.filter((technique: Technique) => { return technique.revoked !== true; }));
    return [techniqueHoverDisposable, techniqueCompletionDisposable];
}
