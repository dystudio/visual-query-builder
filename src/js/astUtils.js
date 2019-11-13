import schemaStore from './schemaStore'
import utils from './utils'
import parser from 'js-sql-parser'

let astUtils = {}

//Compresses a list of columns into a starred version of the list
function colsToStar(oldColumns, tables){
    const schema = schemaStore.getSchema()
    let newColumns = oldColumns

    //First replace  all columns with table.*
    tables.forEach(table => {
        //Get only columns from the table that are NOT in the current column list
        const filteredColumns = schema[table].filter(c => oldColumns.indexOf(c.name) === -1)

        // If all columns from the table are in the list, the filteredList length is 0
        if(filteredColumns.length === 0) {
            //First filter out all the columns from this table
            newColumns = newColumns.filter(col => schema[table].map(c => c.name).indexOf(col) === -1)
            //TO DO Check if the table has an alias when optimizing with table.* and use the alias instead
            newColumns.unshift(table + ".*")
        }
    })

    //Now replace all table.* with a single *
    const starCols = newColumns.filter(c => c.indexOf(".*") > -1)
    if(starCols.length === newColumns.length) newColumns = ["*"]

    return newColumns
}

function getTablesFromCols(columns){
    const schema = schemaStore.getSchema()
    let tables = Object.keys(schema).reduce((tbls, tbl) => {
        //Get only columns from the table that ARE in the current column list
        const filteredColumns = schema[tbl].filter(c => columns.indexOf(c.name) > -1)
        //At least one column is in the list -- Add it
        if(filteredColumns.length) tbls.push({name:tbl, columns:filteredColumns})
        return tbls
    }, [])
    //Now check if the same column is on multiple tables. If so, check which table (if any) only contains that single column and remove it
    return tables.filter(t => t.columns.length > 1 || t.filter(t2 => t.name !== t2.name && t2.columns.indexOf(t.columns[0]) == -1).length)
}

//Get all columns in a select query ast tree without the table. prefix
astUtils.getColumns = function(tree, columnList){
    const schema = schemaStore.getSchema()
    const currTables = astUtils.getTables(tree, [])
    //This will get you a list of all literal columns
    columnList = tree.value.selectItems.value.reduce((arr, curr) => {
      if(curr.type === "Identifier"){
        const vals = curr.value.split(".")
        //First check if column is *
        if(curr.value === "*"){
            //Add all the columns form currTables to the array
            arr = currTables.reduce((arr, tbl) => arr.concat(schema[tbl].map(c => c.name)), arr)
        //Now check if it matches "table.*"
        } else if (curr.value.match(/[^\.]+\.\*$/) !== null){
            //Add the colmns from that table to the array
            if(schema[vals[0]]) arr = arr.concat(schema[vals[0]].map(c => c.name))
        } else {
            //Just add the single column
            arr.push(vals[vals.length-1])
        }
      } else if (curr.type === "FunctionCall") {
            arr.push(curr.name + "(" + curr.params.reduce((str, p, i) => str += p.value + (i+1 === curr.params.length ? "" : ",") ,"") + ")") //TO DO Add the function name with a flag
      }
      return arr
    }, columnList)
    console.log(columnList)
    //Return a list of all expanded columns without the prefix
    return columnList.filter((el, i, self) => i === self.indexOf(el)) //Remove possible duplicates
}

//Recursively get all tables and alias in a select query ast tree
astUtils.getTables = function(tree, tableList){
    return recurse(tree.value, tableList).filter((el, i, self) => i === self.indexOf(el)) //Remove possible duplicates

    function recurse(node, tableList){
        if(!node) return tableList
        const nodeType = node.type.substring(node.type.length-9) === "JoinTable" ? "JoinTable" : node.type
        switch(nodeType){
          case 'TableReference':
          case 'TableFactor':
          case 'SubQuery':
            return recurse(node.value, tableList)
          case 'Select':
            return recurse(node.from, tableList)
          case 'TableReferences':
            return node.value.reduce((list, tr) => recurse(tr, tableList), tableList)
          case 'JoinTable':
            return tableList.concat(recurse(node.left,[])).concat(recurse(node.right,[]))
          case 'Identifier':
            tableList.push(node.value)
          default:
            return tableList
        }
    }      
}

astUtils.addSelectColumn = function(tree, column, table) {
    let newTree = Object.assign({}, tree)
    if(column === "*") column = table + "." + column

    //Push the new column into the tree
    newTree.value.selectItems.value.push({type:"Identifier", value:column, alias:null, hasAs:null})

    //Get current state
    const currColumns = astUtils.getColumns(newTree, [])
    const currTables = astUtils.getTables(newTree, [table]) //Include the table of the column you're adding

    //Convert to * optimized column list
    let newColumns = colsToStar(currColumns, currTables)

    //Finally, add all columns back on the new ast tree
    newTree.value.selectItems.value = newColumns.map(c => { return {type:"Identifier", value:c, alias:null, hasAs:null} })

    return newTree
}


//Recursively add table via natural join to the tree
astUtils.addNaturalJoinTable = function(tree, table) {
    let newTree = JSON.parse(JSON.stringify(tree))
    newTree.value = recurse(newTree.value)
    return newTree

    function recurse(node){
        if(!node) return node
        const nodeType = node.type.substring(node.type.length-9) === "JoinTable" ? "JoinTable" : node.type
        switch(nodeType){
          case 'TableReference':
          case 'SubQuery':
            node.value = recurse(node.value)
            break
          case 'Select':
            node.from = recurse(node.from)
            break
          case 'TableReferences':
            node.value[0] = recurse(node.value[0])
            break
          case 'JoinTable':
            node.left = recurse(node.left)
            break
          case 'TableFactor':
            let leftChild = JSON.parse(JSON.stringify(node))
            let rightChild = { alias:null, hasAs:null, indexHintOpt:null, partition:null, type:"TableFactor", value:{type: "Identifier", value: table} }
            node = {
                type:"NaturalJoinTable",
                left:leftChild,
                right:rightChild,
                leftRight:null,
                outOpt:null
            }
            break
        }
        return node
    } 
}

//Recursively removes table from tree
//implementation built on remove Where
astUtils.removeNaturalJoinTable = function(tree, table) {
    let newTree = JSON.parse(JSON.stringify(tree))
    console.log("recurse start node")
    console.log(newTree.value.from.value[0].value)
    newTree.value.from.value[0].value = recurse(newTree.value.from.value[0].value)
    return newTree

    function recurse(node){
        if(!node) return node
        const nodeType = node.type
        console.log("nodetype =",nodeType)
        switch(nodeType){
            case 'NaturalJoinTable':
                if( node.left.type === "TableFactor" && node.left.value.value === table) {
                    node = node.right
                } else if(node.right.type === "TableFactor" && node.right.value.value === table){
                    node = node.left
                } else {
                    node.left = recurse(node.left)
                    node.right = recurse(node.right)
                }
                break
        }
        return node
    }  
    
}

//adds AND ${column} ${operator} ${val} to end of WHERE clause
/**
examples:
astUtils.where(tree, "actual_time", ">=", 178) //adds actual_time>=178 to end of where
astUtils.where(tree, "dest_city", "=", "'denver'") note how the string needs to include '' inside
astUtils.where(tree, "arrival_delay", "<", 31)
**/
astUtils.addWhereColumn = function(tree, column, operator, val) {
    let newTree = JSON.parse(JSON.stringify(tree))
    let node = newTree.value.where
    let valType = typeof val
    valType = valType.charAt(0).toUpperCase() + valType.substring(1) //Uppercase first letter
    let nodeType = operator.toUpperCase() === "LIKE" ? "LikePredicate" : "ComparisonBooleanPrimary"
    let newNode =  {
        left:{type: "Identifier", value: column},
        right:{type: valType, value: val},
        type:nodeType          
    }
    //We only need the operator if it's not 'like'
    if(operator.toUpperCase() !== "LIKE") newNode.operator = operator

    //Node is null only if where is empty
    if(node == null) {
        newTree.value.where = newNode
    //Append to the current where clause
    } else {
        let prev = null
        //keep recursing until the left leaf of the current node is an identifier (we reached the bottom of the tree)
        //the one previous to it needs to be changed
        do {
            prev = node
            node = node.right
        } while(node.left && node.left.type == "Identifier")
        
        //deep copy of prev into prev.left
        prev.left = JSON.parse(JSON.stringify(prev))
        prev.right = newNode
        //the high level operator needs to be AND
        prev.operator = 'AND'
        prev.type = 'AndExpression'       
    }

    
    return newTree
}

astUtils.getWhereColumn = function(tree, column) {
    return recurse(tree.value.where)

    function recurse(node){
        if(!node) return null
        const nodeType = node.type
        switch(nodeType){
          case 'AndExpression':
          case 'OrExpression':
            return recurse(node.left) || recurse(node.right)
          default:
            return node.left && node.left.type === "Identifier" && node.left.value == column ? node : null
        }
    }    
}

//Remove where clause (or clauses) that match a certain column
//Returns a new copy of the tree (it does not modify the original)
astUtils.removeWhereColumn = function(tree, column, operator) {
    const targetType = operator.toUpperCase() === "LIKE" ? "LikePredicate" : "ComparisonBooleanPrimary"
    let newTree = JSON.parse(JSON.stringify(tree))
    newTree.value.where = recurse(newTree.value.where)
    return newTree

    function recurse(node){
        if(!node) return node
        const nodeType = node.type
        switch(nodeType){
            case 'AndExpression':
            case 'OrExpression':
                if(node.left.type === targetType && node.left.left.value === column) {
                    node = node.right
                } else if(node.right.type === targetType && node.right.left.value === column){
                    node = node.left
                } else {
                    node.left = recurse(node.left)
                    node.right = recurse(node.right)
                }
                break
            default:
                node = node.type === targetType && node.left.value === column ? null : node
        }
        return node
    }  
}

//returns a tree that only has newTables elements in it's FROM clause
function updateTables(tree,newTables) {
    let newTree = JSON.parse(JSON.stringify(tree))
    let queryStr = "SELECT * FROM"
    
    var i
    //add all talbes to query string
    for(i = 0; i < newTables.length; i++) {
        if(i == 0) {
            queryStr += " " + newTables[i]
        }
        else {
            queryStr += " NATURAL JOIN " + newTables[i]
        }
         
    }
    let tempTree = parser.parse(queryStr)
    //deep copy of tempTree's FROM to newTree's FROM
     newTree.value.from = JSON.parse(JSON.stringify(tempTree.value.from))
     return newTree
}

//TO DO - Removes the column from the select clause.
//Additionally it removes any table or tables that no longer have any columns on select by calling removeTable
astUtils.removeSelectColumn = function(tree, column) {
    let newTree = JSON.parse(JSON.stringify(tree))

    //Get current state and remove the column -- TO DO support aggregation functions in the select
    let columns = astUtils.getColumns(newTree, []).filter(c => c !== column)
    //Check if there are no columns from a particular table
    const newTables = getTablesFromCols(columns) //the function is returning an empty array.
    //const newTables = ["weekdays","carriers"]  // for testing purposes as getTablesFromCols isn't working
    const currTables = astUtils.getTables(newTree, [])
    console.log("currTables =",currTables)
    currTables.forEach(table => {
        if(newTables.indexOf(table) === -1) {
            newTree = astUtils.removeNaturalJoinTable(newTree, table)
            //remove all tables from tree        
        }
    })
    //newTree = updateTables(newTree,newTables)
    
    return newTree //for now
    //Convert to * optimized column list
    let newColumns = colsToStar(columns, newTables)

    //Add columns to the tree
    newTree.value.selectItems.value = newColumns.map(c => { return {type:"Identifier", value:c, alias:null, hasAs:null} })
    console.log(columns, columns)

    //Remove where clause for that column

    //Remove grouping for the column

    //Remove ordering for that colum

    return newTree
}

export default astUtils

